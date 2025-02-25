import {
  ProjectGraph,
  ProjectGraphProcessor,
} from '../../config/project-graph';
import {
  ProjectGraphBuilder,
  ProjectGraphDependencyWithFile,
} from '../../project-graph/project-graph-builder';
import { buildExplicitDependencies } from './project-graph/build-dependencies/build-dependencies';
import { readNxJson } from '../../config/configuration';
import { fileExists, readJsonFile } from '../../utils/fileutils';
import { PackageJson } from '../../utils/package-json';
import {
  lockFileExists,
  lockFileHash,
  parseLockFile,
} from './lock-file/lock-file';
import { NrwlJsPluginConfig, NxJsonConfiguration } from '../../config/nx-json';
import { dirname, join } from 'path';
import { projectGraphCacheDirectory } from '../../utils/cache-directory';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { workspaceRoot } from '../../utils/workspace-root';
import { ensureDirSync } from 'fs-extra';
import { performance } from 'perf_hooks';
import {
  CreateDependencies,
  CreateDependenciesContext,
} from '../../utils/nx-plugin';

const createDependencies: CreateDependencies = (context) => {
  const pluginConfig = jsPluginConfig(context.nxJsonConfiguration);

  performance.mark('build typescript dependencies - start');
  const dependencies = buildExplicitDependencies(pluginConfig, context);
  performance.mark('build typescript dependencies - end');
  performance.measure(
    'build typescript dependencies',
    'build typescript dependencies - start',
    'build typescript dependencies - end'
  );
  return dependencies;
};

export const processProjectGraph: ProjectGraphProcessor = async (
  graph,
  context
) => {
  const builder = new ProjectGraphBuilder(graph, context.fileMap);
  const pluginConfig = jsPluginConfig(readNxJson());

  if (pluginConfig.analyzePackageJson) {
    if (
      // during the create-nx-workspace lock file might not exists yet
      lockFileExists() &&
      pluginConfig.analyzeLockfile
    ) {
      const lockHash = lockFileHash();
      let parsedLockFile: ProjectGraph;
      if (lockFileNeedsReprocessing(lockHash)) {
        parsedLockFile = parseLockFile();
        writeLastProcessedLockfileHash(lockHash, parsedLockFile);
      } else {
        parsedLockFile = readParsedLockFile();
      }
      builder.mergeProjectGraph(parsedLockFile);
    }
  }

  const createDependenciesContext: CreateDependenciesContext = {
    ...context,
    graph,
  };

  const dependencies = createDependencies(
    createDependenciesContext
  ) as ProjectGraphDependencyWithFile[];

  for (const dep of dependencies) {
    builder.addDependency(
      dep.source,
      dep.target,
      dep.dependencyType,
      dep.sourceFile
    );
  }

  return builder.getUpdatedProjectGraph();
};

const lockFileHashFile = join(projectGraphCacheDirectory, 'lockfile.hash');
const parsedLockFile = join(
  projectGraphCacheDirectory,
  'parsed-lock-file.json'
);

function lockFileNeedsReprocessing(lockHash: string) {
  try {
    return readFileSync(lockFileHashFile).toString() !== lockHash;
  } catch {
    return true;
  }
}

function writeLastProcessedLockfileHash(hash: string, lockFile: ProjectGraph) {
  ensureDirSync(dirname(lockFileHashFile));
  writeFileSync(parsedLockFile, JSON.stringify(lockFile, null, 2));
  writeFileSync(lockFileHashFile, hash);
}

function readParsedLockFile(): ProjectGraph {
  return JSON.parse(readFileSync(parsedLockFile).toString());
}

function jsPluginConfig(
  nxJson: NxJsonConfiguration
): Required<NrwlJsPluginConfig> {
  const nxJsonConfig: NrwlJsPluginConfig =
    nxJson?.pluginsConfig?.['@nx/js'] ?? nxJson?.pluginsConfig?.['@nrwl/js'];

  // using lerna _before_ installing deps is causing an issue when parsing lockfile.
  // See: https://github.com/lerna/lerna/issues/3807
  // Note that previous attempt to fix this caused issues with Nx itself, thus we're checking
  // for Lerna explicitly.
  // See: https://github.com/nrwl/nx/pull/18784/commits/5416138e1ddc1945d5b289672dfb468e8c544e14
  const analyzeLockfile =
    !existsSync(join(workspaceRoot, 'lerna.json')) ||
    existsSync(join(workspaceRoot, 'nx.json'));

  if (nxJsonConfig) {
    return {
      analyzePackageJson: true,
      analyzeSourceFiles: true,
      analyzeLockfile,
      ...nxJsonConfig,
    };
  }

  if (!fileExists(join(workspaceRoot, 'package.json'))) {
    return {
      analyzeLockfile: false,
      analyzePackageJson: false,
      analyzeSourceFiles: false,
    };
  }

  const packageJson = readJsonFile<PackageJson>(
    join(workspaceRoot, 'package.json')
  );

  const packageJsonDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  if (
    packageJsonDeps['@nx/workspace'] ||
    packageJsonDeps['@nx/js'] ||
    packageJsonDeps['@nx/node'] ||
    packageJsonDeps['@nx/next'] ||
    packageJsonDeps['@nx/react'] ||
    packageJsonDeps['@nx/angular'] ||
    packageJsonDeps['@nx/web'] ||
    packageJsonDeps['@nrwl/workspace'] ||
    packageJsonDeps['@nrwl/js'] ||
    packageJsonDeps['@nrwl/node'] ||
    packageJsonDeps['@nrwl/next'] ||
    packageJsonDeps['@nrwl/react'] ||
    packageJsonDeps['@nrwl/angular'] ||
    packageJsonDeps['@nrwl/web']
  ) {
    return {
      analyzePackageJson: true,
      analyzeLockfile,
      analyzeSourceFiles: true,
    };
  } else {
    return {
      analyzePackageJson: true,
      analyzeLockfile,
      analyzeSourceFiles: false,
    };
  }
}
