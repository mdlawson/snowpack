import merge from 'deepmerge';
import {startService as esbuildStartService} from 'esbuild';
import {EventEmitter} from 'events';
import {promises as fs} from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import path from 'path';
import {performance} from 'perf_hooks';
import rimraf from 'rimraf';
import url from 'url';
import util from 'util';
import {
  generateEnvModule,
  wrapHtmlResponse,
  wrapImportMeta,
  wrapImportProxy,
} from '../build/build-import-proxy';
import {buildFile, runPipelineOptimizeStep} from '../build/build-pipeline';
import {createImportResolver} from '../build/import-resolver';
import srcFileExtensionMapping from '../build/src-file-extension-mapping';
import {removeLeadingSlash} from '../config';
import {stopEsbuild} from '../plugins/plugin-esbuild';
import {transformFileImports} from '../rewrite-imports';
import {printStats} from '../stats-formatter';
import {CommandOptions, SnowpackSourceFile} from '../types/snowpack';
import {getEncodingType, getExt, replaceExt} from '../util';
import {getInstallTargets, run as installRunner} from './install';

async function installOptimizedDependencies(
  allFilesToResolveImports: Record<string, SnowpackSourceFile>,
  installDest: string,
  commandOptions: CommandOptions,
) {
  console.log(colors.yellow('! installing dependencies...'));
  const installConfig = merge(commandOptions.config, {
    installOptions: {
      dest: installDest,
      env: {NODE_ENV: process.env.NODE_ENV || 'production'},
      treeshake: commandOptions.config.installOptions.treeshake ?? true,
    },
  });
  // 1. Scan imports from your final built JS files.
  const installTargets = await getInstallTargets(
    installConfig,
    Object.values(allFilesToResolveImports),
  );
  // 2. Install dependencies, based on the scan of your final build.
  const installResult = await installRunner({
    ...commandOptions,
    installTargets,
    config: installConfig,
  });
  // 3. Print stats immediate after install output.
  if (installResult.stats) {
    console.log(printStats(installResult.stats));
  }
  return installResult;
}

export async function command(commandOptions: CommandOptions) {
  const {cwd, config} = commandOptions;
  const messageBus = new EventEmitter();

  // TODO: update this with a more robust / typed log event
  function logEvent({level, id, msg, args}) {
    let logger = console.log;
    let color = (stdout: string) => stdout;
    if (level === 'warn') {
      logger = console.warn;
      color = colors.yellow;
    }
    if (level === 'error') {
      color = colors.red;
      logger = console.error;
    }
    const output = msg || util.format.apply(util, args);
    logger(`${id ? colors.blue(`[${id}] `) : ''}${color(output)}`);
  }
  messageBus.on('CONSOLE', logEvent);
  messageBus.on('WORKER_COMPLETE', logEvent);
  messageBus.on('WORKER_MSG', logEvent);
  messageBus.on('WORKER_RESET', logEvent);
  messageBus.on('WORKER_START', logEvent);
  messageBus.on('WORKER_UPDATE', logEvent);

  const buildDirectoryLoc = config.devOptions.out;
  const internalFilesBuildLoc = path.join(buildDirectoryLoc, config.buildOptions.metaDir);

  if (config.buildOptions.clean) {
    rimraf.sync(buildDirectoryLoc);
  }
  mkdirp.sync(buildDirectoryLoc);
  mkdirp.sync(internalFilesBuildLoc);

  let relDest = path.relative(cwd, config.devOptions.out);
  if (!relDest.startsWith(`..${path.sep}`)) {
    relDest = `.${path.sep}` + relDest;
  }

  for (const runPlugin of config.plugins) {
    if (runPlugin.run) {
      await runPlugin
        .run({
          isDev: false,
          isHmrEnabled: false,
          // @ts-ignore: internal API only
          log: (msg, data = {}) => {
            messageBus.emit(msg, {...data, id: runPlugin.name});
          },
        })
        .catch((err) => {
          messageBus.emit('CONSOLE', {level: 'error', id: runPlugin.name, ...err});
        });
    }
  }

  // Write the `import.meta.env` contents file to disk
  await fs.writeFile(path.join(internalFilesBuildLoc, 'env.js'), generateEnvModule('production'));

  const includeFileSets: [string, string, string[]][] = [];
  for (const [fromDisk, toUrl] of Object.entries(config.mount)) {
    const dirDisk = path.resolve(cwd, fromDisk);
    const dirDest = path.resolve(buildDirectoryLoc, removeLeadingSlash(toUrl));
    const allFiles = glob.sync(`**/*`, {
      ignore: config.exclude,
      cwd: dirDisk,
      absolute: true,
      nodir: true,
      dot: true,
    });
    const allBuildNeededFiles: string[] = [];
    await Promise.all(
      allFiles.map(async (f) => {
        f = path.resolve(f); // this is necessary since glob.sync() returns paths with / on windows.  path.resolve() will switch them to the native path separator.
        allBuildNeededFiles.push(f);
      }),
    );
    includeFileSets.push([dirDisk, dirDest, allBuildNeededFiles]);
  }

  const allBuiltFromFiles = new Set<string>();
  const allFilesToResolveImports: Record<string, SnowpackSourceFile> = {};

  console.log(colors.yellow('! building source...'));
  const buildStart = performance.now();

  for (const [dirDisk, dirDest, allFiles] of includeFileSets) {
    for (const locOnDisk of allFiles) {
      const {baseExt: fileExt} = getExt(locOnDisk);
      let outLoc = locOnDisk.replace(dirDisk, dirDest);
      let builtLocOnDisk = locOnDisk;
      const extToReplace = config._extensionMap[fileExt] || srcFileExtensionMapping[fileExt];
      if (extToReplace) {
        outLoc = replaceExt(outLoc, extToReplace);
        builtLocOnDisk = replaceExt(builtLocOnDisk, extToReplace);
      }
      const builtFileOutput = await buildFile(locOnDisk, {
        plugins: config.plugins,
        messageBus,
        isDev: false,
        isHmrEnabled: false,
      });
      allBuiltFromFiles.add(locOnDisk);
      const {baseExt, expandedExt} = getExt(outLoc);
      let contents =
        builtFileOutput[
          config._extensionMap[fileExt] || srcFileExtensionMapping[fileExt] || fileExt
        ];
      if (!contents) {
        continue;
      }
      const cssOutPath = outLoc.replace(/.js$/, '.css');
      mkdirp.sync(path.dirname(outLoc));
      switch (baseExt) {
        case '.js': {
          if (builtFileOutput['.css']) {
            await fs.mkdir(path.dirname(cssOutPath), {recursive: true});
            await fs.writeFile(cssOutPath, builtFileOutput['.css'], 'utf-8');
            contents = `import './${path.basename(cssOutPath)}';\n` + contents;
          }
          contents = wrapImportMeta({code: contents, env: true, isDev: false, hmr: false, config});
          allFilesToResolveImports[outLoc] = {baseExt, expandedExt, contents, locOnDisk};
          break;
        }
        case '.html': {
          contents = wrapHtmlResponse({
            code: contents,
            isDev: false,

            hmr: false,
            config,
          });
          allFilesToResolveImports[outLoc] = {baseExt, expandedExt, contents, locOnDisk};
          break;
        }
      }
      await fs.writeFile(outLoc, contents, getEncodingType(baseExt));
    }
  }
  stopEsbuild();

  const buildEnd = performance.now();
  console.log(
    `${colors.green('✔')} ${colors.bold('snowpack')} build complete ${colors.dim(
      `[${((buildEnd - buildStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  const installDest = path.join(buildDirectoryLoc, config.buildOptions.webModulesUrl);
  const installResult = await installOptimizedDependencies(
    allFilesToResolveImports,
    installDest,
    commandOptions,
  );
  if (!installResult.success || installResult.hasError) {
    process.exit(1);
  }

  const allImportProxyFiles = new Set<string>();
  for (const [outLoc, file] of Object.entries(allFilesToResolveImports)) {
    const resolveImportSpecifier = createImportResolver({
      fileLoc: file.locOnDisk!, // we’re confident these are reading from disk because we just read them
      dependencyImportMap: installResult.importMap,
      config,
    });
    const resolvedCode = await transformFileImports(file, (spec) => {
      // Try to resolve the specifier to a known URL in the project
      let resolvedImportUrl = resolveImportSpecifier(spec);
      if (!resolvedImportUrl || url.parse(resolvedImportUrl).protocol) {
        return spec;
      }
      const extName = path.extname(resolvedImportUrl);
      const isProxyImport = extName && extName !== '.js';

      // We treat ".proxy.js" files special: we need to make sure that they exist on disk
      // in the final build, so we mark them to be written to disk at the next step.
      const isAbsoluteUrlPath = path.isAbsolute(resolvedImportUrl);
      if (isProxyImport) {
        resolvedImportUrl = resolvedImportUrl + '.proxy.js';
        if (isAbsoluteUrlPath) {
          allImportProxyFiles.add(
            path.resolve(buildDirectoryLoc, removeLeadingSlash(resolvedImportUrl)),
          );
        } else {
          allImportProxyFiles.add(path.resolve(path.dirname(outLoc), resolvedImportUrl));
        }
      }

      // When dealing with an absolute import path, we need to honor the baseUrl
      if (isAbsoluteUrlPath) {
        resolvedImportUrl = path.relative(
          path.dirname(outLoc),
          path.resolve(buildDirectoryLoc, removeLeadingSlash(resolvedImportUrl)),
        );
      }

      if (!resolvedImportUrl.startsWith('.'))
        resolvedImportUrl = './' + removeLeadingSlash(resolvedImportUrl);

      return resolvedImportUrl.replace(/\\/g, '/'); // replace Windows backslashes at the end, after resolution
    });
    await fs.mkdir(path.dirname(outLoc), {recursive: true});
    await fs.writeFile(outLoc, resolvedCode);
  }

  for (const importProxyFileLoc of allImportProxyFiles) {
    const originalFileLoc = importProxyFileLoc.replace('.proxy.js', '');
    const proxiedExt = path.extname(originalFileLoc);
    const proxiedCode = await fs.readFile(originalFileLoc, getEncodingType(proxiedExt));
    const proxiedUrl = originalFileLoc.substr(buildDirectoryLoc.length).replace(/\\/g, '/');
    const proxyCode = await wrapImportProxy({
      url: proxiedUrl,
      code: proxiedCode,
      isDev: false,
      hmr: false,
      config,
    });
    await fs.writeFile(importProxyFileLoc, proxyCode, getEncodingType('.js'));
  }

  await runPipelineOptimizeStep(buildDirectoryLoc, {
    plugins: config.plugins,
    messageBus,
    isDev: false,
    isHmrEnabled: false,
  });

  if (config.buildOptions.minify) {
    const minifierStart = performance.now();
    console.log(colors.yellow('! minifying javascript...'));
    let minifierService = await esbuildStartService();
    const allJsFiles = glob.sync(path.join(buildDirectoryLoc, '**/*.js'));
    for (const jsFile of allJsFiles) {
      const jsFileContents = await fs.readFile(jsFile, 'utf-8');
      const {js} = await minifierService.transform(jsFileContents, {minify: true});
      js && (await fs.writeFile(jsFile, js, 'utf-8'));
    }
    const minifierEnd = performance.now();
    console.log(
      `${colors.green('✔')} ${colors.bold('snowpack')} minification complete ${colors.dim(
        `[${((minifierEnd - minifierStart) / 1000).toFixed(2)}s]`,
      )}`,
    );
    minifierService.stop();
  }

  process.stdout.write(`\n${colors.underline(colors.green(colors.bold('▶ Build Complete!')))}\n\n`);
}
