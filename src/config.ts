import chalk from 'chalk';
import {cosmiconfigSync} from 'cosmiconfig';
import {all as merge} from 'deepmerge';
import {validate} from 'jsonschema';
import path from 'path';
import {Plugin as RollupPlugin} from 'rollup';
import yargs from 'yargs-parser';
import {esbuildPlugin} from './commands/esbuildPlugin';
import {BUILD_DEPENDENCIES_DIR, DEV_DEPENDENCIES_DIR} from './util';

const CONFIG_NAME = 'snowpack';
const ALWAYS_EXCLUDE = ['**/node_modules/**/*', '**/.types/**/*'];
const SCRIPT_TYPES_WEIGHTED = {
  proxy: 1,
  mount: 2,
  run: 3,
  build: 4,
  bundle: 100,
} as {[type in ScriptType]: number};

type ScriptType = 'proxy' | 'mount' | 'run' | 'build' | 'bundle';

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[P] extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : DeepPartial<T[P]>;
};

export type EnvVarReplacements = Record<string, string | number | true>;

export type SnowpackPluginBuildArgs = {
  contents: string;
  filePath: string;
  isDev: boolean;
};
export type SnowpackPluginTransformArgs = {
  contents: string;
  urlPath: string;
  isDev: boolean;
};
export type SnowpackPluginBuildResult = {
  result: string;
  resources?: {css?: string};
};
export type SnowpackPluginTransformResult = {
  result: string;
  resources?: {css?: string};
};
export type SnowpackPlugin = {
  defaultBuildScript?: string;
  knownEntrypoints?: string[];
  build?: (
    args: SnowpackPluginBuildArgs,
  ) => null | SnowpackPluginBuildResult | Promise<null | SnowpackPluginBuildResult>;
  transform?: (
    args: SnowpackPluginTransformArgs,
  ) => null | SnowpackPluginTransformResult | Promise<null | SnowpackPluginTransformResult>;
  bundle?(args: {
    srcDirectory: string;
    destDirectory: string;
    jsFilePaths: Set<string>;
    log: (msg) => void;
  }): Promise<void>;
};
export type BuildScript = {
  id: string;
  match: string[];
  type: ScriptType;
  cmd: string;
  watch?: string;
  plugin?: SnowpackPlugin;
  args?: any;
};

// interface this library uses internally
export interface SnowpackConfig {
  extends?: string;
  exclude: string[];
  knownEntrypoints: string[];
  webDependencies?: {[packageName: string]: string};
  scripts: BuildScript[];
  plugins: SnowpackPlugin[];
  homepage?: string;
  devOptions: {
    port: number;
    out: string;
    fallback: string;
    open: string;
    bundle: boolean | undefined;
  };
  installOptions: {
    dest: string;
    env: EnvVarReplacements;
    installTypes: boolean;
    sourceMap?: boolean | 'inline';
    externalPackage: string[];
    alias: {[key: string]: string};
    rollup: {
      plugins: RollupPlugin[]; // for simplicity, only Rollup plugins are supported for now
      dedupe?: string[];
      namedExports?: {[filepath: string]: string[]};
    };
  };
}

export interface CLIFlags extends Omit<Partial<SnowpackConfig['installOptions']>, 'env'> {
  help?: boolean; // display help text
  version?: boolean; // display Snowpack version
  reload?: boolean;
  config?: string; // manual path to config file
  env?: string[]; // env vars
  open?: string[];
}

// default settings
const DEFAULT_CONFIG: Partial<SnowpackConfig> = {
  exclude: ['__tests__/**/*', '**/*.@(spec|test).*'],
  plugins: [],
  installOptions: {
    dest: 'web_modules',
    externalPackage: [],
    installTypes: false,
    env: {},
    alias: {},
    rollup: {
      plugins: [],
      dedupe: [],
    },
  },
  devOptions: {
    port: 8080,
    open: 'default',
    out: 'build',
    fallback: 'index.html',
    bundle: undefined,
  },
};

const configSchema = {
  type: 'object',
  properties: {
    extends: {type: 'string'},
    install: {type: 'array', items: {type: 'string'}},
    exclude: {type: 'array', items: {type: 'string'}},
    plugins: {type: 'array'},
    webDependencies: {
      type: ['object'],
      additionalProperties: {type: 'string'},
    },
    scripts: {
      type: ['object'],
      additionalProperties: {type: 'string'},
    },
    devOptions: {
      type: 'object',
      properties: {
        port: {type: 'number'},
        out: {type: 'string'},
        fallback: {type: 'string'},
        bundle: {type: 'boolean'},
        open: {type: 'string'},
      },
    },
    installOptions: {
      type: 'object',
      properties: {
        dest: {type: 'string'},
        externalPackage: {type: 'array', items: {type: 'string'}},
        installTypes: {type: 'boolean'},
        sourceMap: {oneOf: [{type: 'boolean'}, {type: 'string'}]},
        alias: {
          type: 'object',
          additionalProperties: {type: 'string'},
        },
        env: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              {id: 'EnvVarString', type: 'string'},
              {id: 'EnvVarNumber', type: 'number'},
              {id: 'EnvVarTrue', type: 'boolean', enum: [true]},
            ],
          },
        },
        rollup: {
          type: 'object',
          properties: {
            plugins: {type: 'array', items: {type: 'object'}},
            dedupe: {
              type: 'array',
              items: {type: 'string'},
            },
            namedExports: {
              type: 'object',
              additionalProperties: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    },
  },
};

/**
 * Convert CLI flags to an incomplete Snowpack config representation.
 * We need to be careful about setting properties here if the flag value
 * is undefined, since the deep merge strategy would then overwrite good
 * defaults with 'undefined'.
 */
function expandCliFlags(flags: CLIFlags): DeepPartial<SnowpackConfig> {
  const result = {
    installOptions: {} as any,
    devOptions: {} as any,
  };
  const {help, version, reload, config, ...relevantFlags} = flags;
  for (const [flag, val] of Object.entries(relevantFlags)) {
    if (flag === '_' || flag.includes('-')) {
      continue;
    }
    if (configSchema.properties[flag]) {
      result[flag] = val;
      continue;
    }
    if (configSchema.properties.installOptions.properties[flag]) {
      result.installOptions[flag] = val;
      continue;
    }
    if (configSchema.properties.devOptions.properties[flag]) {
      result.devOptions[flag] = val;
      continue;
    }
    console.error(`Unknown CLI flag: "${flag}"`);
    process.exit(1);
  }
  if (result.installOptions.env) {
    result.installOptions.env = result.installOptions.env.reduce((acc, id) => {
      const index = id.indexOf('=');
      const [key, val] = index > 0 ? [id.substr(0, index), id.substr(index + 1)] : [id, true];
      acc[key] = val;
      return acc;
    }, {});
  }
  return result;
}

type RawScripts = {[id: string]: string};
function normalizeScripts(cwd: string, scripts: RawScripts): BuildScript[] {
  const processedScripts: BuildScript[] = [];
  if (Object.keys(scripts).filter((k) => k.startsWith('bundle:')).length > 1) {
    handleConfigError(`scripts can only contain 1 script of type "bundle:".`);
  }
  for (const scriptId of Object.keys(scripts)) {
    if (scriptId.includes('::watch')) {
      continue;
    }
    const [scriptType, scriptMatch] = scriptId.split(':') as [ScriptType, string];
    if (!SCRIPT_TYPES_WEIGHTED[scriptType]) {
      handleConfigError(`scripts[${scriptId}]: "${scriptType}" is not a known script type.`);
    }
    const cmd = (scripts[scriptId] as any) as string;
    const newScriptConfig: BuildScript = {
      id: scriptId,
      type: scriptType,
      match: scriptMatch.split(','),
      cmd,
      watch: (scripts[`${scriptId}::watch`] as any) as string | undefined,
    };
    if (newScriptConfig.watch) {
      newScriptConfig.watch = newScriptConfig.watch.replace('$1', newScriptConfig.cmd);
    }
    if (scriptType === 'mount') {
      const cmdArr = cmd.split(/\s+/);
      if (cmdArr[0] !== 'mount') {
        handleConfigError(`scripts[${scriptId}] must use the mount command`);
      }
      cmdArr.shift();
      const {to, _} = yargs(cmdArr);
      if (_.length !== 1) {
        handleConfigError(`scripts[${scriptId}] must use the format: "mount dir [--to /PATH]"`);
      }
      if (to && to[0] !== '/') {
        handleConfigError(
          `scripts[${scriptId}]: "--to ${to}" must be a URL path, and start with a "/"`,
        );
      }
      const dirDisk = cmdArr[0];
      const dirUrl = to || `/${cmdArr[0]}`;
      newScriptConfig.args = {fromDisk: dirDisk, toUrl: dirUrl};
    }
    if (scriptType === 'proxy') {
      const cmdArr = cmd.split(/\s+/);
      if (cmdArr[0] !== 'proxy') {
        handleConfigError(`scripts[${scriptId}] must use the proxy command`);
      }
      cmdArr.shift();
      const {to, _} = yargs(cmdArr);
      if (_.length !== 1) {
        handleConfigError(
          `scripts[${scriptId}] must use the format: "proxy http://SOME.URL --to /PATH"`,
        );
      }
      if (to && to[0] !== '/') {
        handleConfigError(
          `scripts[${scriptId}]: "--to ${to}" must be a URL path, and start with a "/"`,
        );
      }
      newScriptConfig.args = {fromUrl: _[0], toUrl: to};
    }
    processedScripts.push(newScriptConfig);
  }
  const allBuildMatch = new Set<string>();
  for (const {type, match} of processedScripts) {
    if (type !== 'build') {
      continue;
    }
    for (const ext of match) {
      if (allBuildMatch.has(ext)) {
        handleConfigError(
          `Multiple "scripts" match the "${ext}" file extension.\nCurrently, only one script per file type is supported.`,
        );
      }
      allBuildMatch.add(ext);
    }
  }

  if (!scripts['mount:web_modules']) {
    const fromDisk =
      process.env.NODE_ENV === 'production' ? BUILD_DEPENDENCIES_DIR : DEV_DEPENDENCIES_DIR;
    processedScripts.push({
      id: 'mount:web_modules',
      type: 'mount',
      match: ['web_modules'],
      cmd: `mount $WEB_MODULES --to /web_modules`,
      args: {
        fromDisk,
        toUrl: '/web_modules',
      },
    });
  }

  const defaultBuildMatch = ['js', 'jsx', 'ts', 'tsx'].filter((ext) => !allBuildMatch.has(ext));
  if (defaultBuildMatch.length > 0) {
    const defaultBuildWorkerConfig = {
      id: `build:${defaultBuildMatch.join(',')}`,
      type: 'build',
      match: defaultBuildMatch,
      cmd: '(default) esbuild',
      plugin: esbuildPlugin(),
    } as BuildScript;
    processedScripts.push(defaultBuildWorkerConfig);
  }
  processedScripts.sort((a, b) => {
    if (a.id === 'mount:web_modules') {
      return -1;
    }
    if (b.id === 'mount:web_modules') {
      return 1;
    }
    if (a.type === b.type) {
      return a.id.localeCompare(b.id);
    }
    return SCRIPT_TYPES_WEIGHTED[a.type] - SCRIPT_TYPES_WEIGHTED[b.type];
  });
  return processedScripts;
}

/** resolve --dest relative to cwd, etc. */
function normalizeConfig(config: SnowpackConfig): SnowpackConfig {
  const cwd = process.cwd();
  config.knownEntrypoints = (config as any).install || [];
  config.installOptions.dest = path.resolve(cwd, config.installOptions.dest);
  config.devOptions.out = path.resolve(cwd, config.devOptions.out);
  config.exclude = Array.from(new Set([...ALWAYS_EXCLUDE, ...config.exclude]));
  if (!config.scripts) {
    config.exclude.push('**/.*');
    config.scripts = {
      'mount:*': 'mount . --to /',
    } as any;
  }
  const allPlugins = {};
  config.plugins = (config.plugins as any).map((plugin: string | [string, any]) => {
    const configPluginPath = Array.isArray(plugin) ? plugin[0] : plugin;
    const configPluginOptions = (Array.isArray(plugin) && plugin[1]) || {};
    const configPluginLoc = require.resolve(configPluginPath, {paths: [cwd]});
    const configPlugin = require(configPluginLoc)(config, configPluginOptions);
    if (
      (configPlugin.build ? 1 : 0) +
        (configPlugin.transform ? 1 : 0) +
        (configPlugin.bundle ? 1 : 0) >
      1
    ) {
      handleConfigError(
        `plugin[${configPluginLoc}]: A valid plugin can only have one build(), transform(), or bundle() function.`,
      );
    }
    allPlugins[configPluginPath] = configPlugin;
    if (configPlugin.knownEntrypoints) {
      config.knownEntrypoints.push(...configPlugin.knownEntrypoints);
    }
    if (
      configPlugin.defaultBuildScript &&
      !(config.scripts as any)[configPlugin.defaultBuildScript] &&
      !Object.values(config.scripts as any).includes(configPluginPath)
    ) {
      (config.scripts as any)[configPlugin.defaultBuildScript] = configPluginPath;
    }
    return configPlugin;
  });
  if (config.devOptions.bundle === true && !config.scripts['bundle:*']) {
    handleConfigError(`--bundle set to true, but no "bundle:*" script/plugin was provided.`);
  }
  config.scripts = normalizeScripts(cwd, config.scripts as any);
  config.scripts.forEach((script: BuildScript) => {
    if (script.type === 'build' && !script.plugin) {
      if (allPlugins[script.cmd]?.build) {
        script.plugin = allPlugins[script.cmd];
      } else if (allPlugins[script.cmd] && !allPlugins[script.cmd].build) {
        handleConfigError(`scripts[${script.id}]: Plugin "${script.cmd}" has no build script.`);
      } else if (script.cmd.startsWith('@') || script.cmd.startsWith('.')) {
        handleConfigError(
          `scripts[${script.id}]: Register plugin "${script.cmd}" in your Snowpack "plugins" config.`,
        );
      }
    }
    if (script.type === 'bundle' && !script.plugin) {
      if (allPlugins[script.cmd]?.bundle) {
        script.plugin = allPlugins[script.cmd];
      } else if (allPlugins[script.cmd] && !allPlugins[script.cmd].bundle) {
        handleConfigError(`scripts[${script.id}]: Plugin "${script.cmd}" has no bundle script.`);
      } else if (script.cmd.startsWith('@') || script.cmd.startsWith('.')) {
        handleConfigError(
          `scripts[${script.id}]: Register plugin "${script.cmd}" in your Snowpack "plugins" config.`,
        );
      }
    }
  });
  return config;
}

function handleConfigError(msg: string) {
  console.error(`[error]: ${msg}`);
  process.exit(1);
}

function handleValidationErrors(filepath: string, errors: {toString: () => string}[]) {
  console.error(chalk.red(`! ${filepath || 'Configuration error'}`));
  console.error(errors.map((err) => `    - ${err.toString()}`).join('\n'));
  console.error(`    See https://www.snowpack.dev/#configuration for more info.`);
  process.exit(1);
}

function handleDeprecatedConfigError(mainMsg: string, ...msgs: string[]) {
  console.error(chalk.red(mainMsg));
  msgs.forEach(console.error);
  console.error(`See https://www.snowpack.dev/#configuration for more info.`);
  process.exit(1);
}

function validateConfigAgainstV1(rawConfig: any, cliFlags: any) {
  // Moved!
  if (rawConfig.dedupe || cliFlags.dedupe) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `dedupe` is now `installOptions.rollup.dedupe`.',
    );
  }
  if (rawConfig.namedExports || cliFlags.namedExports) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `namedExports` is now `installOptions.rollup.namedExports`.',
    );
  }
  if (rawConfig.rollup) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] top-level `rollup` config is now `installOptions.rollup`.',
    );
  }
  if (rawConfig.installOptions?.include) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.include` is now `include` but its syntax has also changed!',
    );
  }
  if (rawConfig.installOptions?.exclude) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `installOptions.exclude` is now `exclude`.');
  }
  if (Array.isArray(rawConfig.webDependencies)) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] The `webDependencies` array is now `install`.',
    );
  }
  if (rawConfig.knownEntrypoints) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `knownEntrypoints` is now `install`.');
  }
  if (rawConfig.entrypoints) {
    handleDeprecatedConfigError('[Snowpack v1 -> v2] `entrypoints` is now `install`.');
  }
  if (rawConfig.include) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] All files are now included by default. "include" config is safe to remove.',
      'Whitelist & include specific folders via "mount" build scripts.',
    );
  }
  // Replaced!
  if (rawConfig.source || cliFlags.source) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `source` is now detected automatically, this config is safe to remove.',
    );
  }
  if (rawConfig.stat || cliFlags.stat) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `stat` is now the default output, this config is safe to remove.',
    );
  }
  if (
    rawConfig.scripts &&
    Object.keys(rawConfig.scripts).filter((k) => k.startsWith('lintall')).length > 0
  ) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `scripts["lintall:..."]` has been renamed to scripts["run:..."]',
    );
  }
  if (
    rawConfig.scripts &&
    Object.keys(rawConfig.scripts).filter((k) => k.startsWith('plugin:`')).length > 0
  ) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `scripts["plugin:..."]` have been renamed to scripts["build:..."].',
    );
  }
  // Removed!
  if (rawConfig.devOptions?.dist) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `devOptions.dist` is no longer required. This config is safe to remove.',
      `If you'd still like to host your src/ directory at the "/_dist/*" URL, create a mount script:',
      '    {"scripts": {"mount:src": "mount src --to /_dist_"}} `,
    );
  }
  if (rawConfig.hash || cliFlags.hash) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.hash` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.nomodule || cliFlags.nomodule) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.nomodule` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.nomoduleOutput || cliFlags.nomoduleOutput) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.nomoduleOutput` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.babel || cliFlags.babel) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.babel` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.optimize || cliFlags.optimize) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.optimize` has been replaced by `snowpack build`.',
    );
  }
  if (rawConfig.installOptions?.strict || cliFlags.strict) {
    handleDeprecatedConfigError(
      '[Snowpack v1 -> v2] `installOptions.strict` is no longer supported.',
    );
  }
}

export function loadAndValidateConfig(flags: CLIFlags, pkgManifest: any): SnowpackConfig {
  const explorerSync = cosmiconfigSync(CONFIG_NAME, {
    // only support these 3 types of config for now
    searchPlaces: ['package.json', 'snowpack.config.js', 'snowpack.config.json'],
    // don't support crawling up the folder tree:
    stopDir: path.dirname(process.cwd()),
  });

  let result;
  // if user specified --config path, load that
  if (flags.config) {
    result = explorerSync.load(path.resolve(process.cwd(), flags.config));
    if (!result) {
      handleConfigError(`Could not locate Snowpack config at ${flags.config}`);
    }
  }

  // If no config was found above, search for one.
  result = result || explorerSync.search();

  // If still no config found, assume none exists and use the default config.
  if (!result || !result.config || result.isEmpty) {
    result = {config: {...DEFAULT_CONFIG}};
  }

  // validate against schema; throw helpful user if invalid
  const config: SnowpackConfig = result.config;
  validateConfigAgainstV1(config, flags);
  const cliConfig = expandCliFlags(flags);

  const validation = validate(config, configSchema, {
    allowUnknownAttributes: false,
    propertyName: CONFIG_NAME,
  });
  if (validation.errors && validation.errors.length > 0) {
    handleValidationErrors(result.filepath, validation.errors);
    process.exit(1);
  }

  let extendConfig: SnowpackConfig | {} = {};
  if (config.extends) {
    const extendConfigLoc = config.extends.startsWith('.')
      ? path.resolve(path.dirname(result.filepath), config.extends)
      : require.resolve(config.extends, {paths: [process.cwd()]});
    const extendResult = explorerSync.load(extendConfigLoc);
    if (!extendResult) {
      handleConfigError(`Could not locate Snowpack config at ${flags.config}`);
      process.exit(1);
    }
    extendConfig = extendResult.config;
    const extendValidation = validate(extendConfig, configSchema, {
      allowUnknownAttributes: false,
      propertyName: CONFIG_NAME,
    });
    if (extendValidation.errors && extendValidation.errors.length > 0) {
      handleValidationErrors(result.filepath, extendValidation.errors);
      process.exit(1);
    }
  }
  // if valid, apply config over defaults
  const mergedConfig = merge<SnowpackConfig>([
    DEFAULT_CONFIG,
    extendConfig,
    {
      webDependencies: pkgManifest.webDependencies,
      homepage: pkgManifest.homepage,
    },
    config,
    cliConfig as any,
  ]);
  for (const webDependencyName of Object.keys(mergedConfig.webDependencies || {})) {
    if (pkgManifest.dependencies && pkgManifest.dependencies[webDependencyName]) {
      handleConfigError(
        `"${webDependencyName}" is included in "webDependencies". Please remove it from your package.json "dependencies" config.`,
      );
    }
    if (pkgManifest.devDependencies && pkgManifest.devDependencies[webDependencyName]) {
      handleConfigError(
        `"${webDependencyName}" is included in "webDependencies". Please remove it from your package.json "devDependencies" config.`,
      );
    }
  }

  // if CLI flags present, apply those as overrides
  return normalizeConfig(mergedConfig);
}
