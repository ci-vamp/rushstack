// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';

import { HeftPluginConfiguration } from '../configuration/HeftPluginConfiguration';
import {
  HeftTaskPluginDefinition,
  type HeftPluginDefinitionBase
} from '../configuration/HeftPluginDefinition';
import type { HeftPhase } from './HeftPhase';
import type {
  IHeftConfigurationJsonTaskSpecifier,
  IHeftConfigurationJsonPluginSpecifier
} from '../utilities/CoreConfigFiles';
import type { IHeftTaskPlugin } from '../pluginFramework/IHeftPlugin';
import type { IScopedLogger } from '../pluginFramework/logging/ScopedLogger';

const RESERVED_TASK_NAMES: Set<string> = new Set(['clean']);

let _copyFilesPluginDefinition: HeftTaskPluginDefinition | undefined;
function _getCopyFilesPluginDefinition(): HeftTaskPluginDefinition {
  if (!_copyFilesPluginDefinition) {
    _copyFilesPluginDefinition = HeftTaskPluginDefinition.loadFromObject({
      heftPluginDefinitionJson: {
        pluginName: 'copy-files-plugin',
        entryPoint: './lib/plugins/CopyFilesPlugin',
        optionsSchema: './lib/schemas/copy-files-options.schema.json'
      },
      packageRoot: `${__dirname}/../..`,
      packageName: '@rushstack/heft'
    });
  }
  return _copyFilesPluginDefinition;
}

let _deleteFilesPluginDefinition: HeftTaskPluginDefinition | undefined;
function _getDeleteFilesPluginDefinition(): HeftTaskPluginDefinition {
  if (!_deleteFilesPluginDefinition) {
    _deleteFilesPluginDefinition = HeftTaskPluginDefinition.loadFromObject({
      heftPluginDefinitionJson: {
        pluginName: 'delete-files-plugin',
        entryPoint: './lib/plugins/DeleteFilesPlugin',
        optionsSchema: './lib/schemas/delete-files-options.schema.json'
      },
      packageRoot: `${__dirname}/../..`,
      packageName: '@rushstack/heft'
    });
  }
  return _deleteFilesPluginDefinition;
}

let _runScriptPluginDefinition: HeftTaskPluginDefinition | undefined;
function _getRunScriptPluginDefinition(): HeftTaskPluginDefinition {
  if (!_runScriptPluginDefinition) {
    _runScriptPluginDefinition = HeftTaskPluginDefinition.loadFromObject({
      heftPluginDefinitionJson: {
        pluginName: 'run-script-plugin',
        entryPoint: './lib/plugins/RunScriptPlugin',
        optionsSchema: './lib/schemas/run-script-options.schema.json'
      },
      packageRoot: `${__dirname}/../..`,
      packageName: '@rushstack/heft'
    });
  }
  return _runScriptPluginDefinition;
}

let _nodeServicePluginDefinition: HeftTaskPluginDefinition | undefined;
function _getNodeServicePluginDefinition(): HeftTaskPluginDefinition {
  if (!_nodeServicePluginDefinition) {
    _nodeServicePluginDefinition = HeftTaskPluginDefinition.loadFromObject({
      heftPluginDefinitionJson: {
        pluginName: 'node-service-plugin',
        entryPoint: './lib/plugins/NodeServicePlugin'
      },
      packageRoot: `${__dirname}/../..`,
      packageName: '@rushstack/heft'
    });
  }
  return _nodeServicePluginDefinition;
}

/**
 * @internal
 */
export class HeftTask {
  private _parentPhase: HeftPhase;
  private _taskName: string;
  private _taskSpecifier: IHeftConfigurationJsonTaskSpecifier;
  private _consumingTasks: Set<HeftTask> | undefined;
  private _dependencyTasks: Set<HeftTask> | undefined;

  private _taskPluginDefinition: HeftTaskPluginDefinition | undefined;
  private _taskPlugin: IHeftTaskPlugin | undefined;

  public get parentPhase(): HeftPhase {
    return this._parentPhase;
  }

  public get taskName(): string {
    return this._taskName;
  }

  public get consumingTasks(): ReadonlySet<HeftTask> {
    if (!this._consumingTasks) {
      // Force initialize all dependency relationships
      // This needs to operate on every phase in the set because the relationships are only specified
      // in the consuming phase.
      const { tasks } = this._parentPhase;

      for (const task of tasks) {
        task._consumingTasks = new Set();
      }
      for (const task of tasks) {
        for (const dependency of task.dependencyTasks) {
          dependency._consumingTasks!.add(task);
        }
      }
    }

    return this._consumingTasks!;
  }

  public get pluginDefinition(): HeftTaskPluginDefinition {
    if (!this._taskPluginDefinition) {
      throw new InternalError(
        'HeftTask.ensureInitializedAsync() must be called before accessing HeftTask.pluginDefinition.'
      );
    }
    return this._taskPluginDefinition;
  }

  public get pluginOptions(): object | undefined {
    return this._taskSpecifier.taskEvent?.options || this._taskSpecifier.taskPlugin?.options;
  }

  public get dependencyTasks(): Set<HeftTask> {
    if (!this._dependencyTasks) {
      this._dependencyTasks = new Set();
      const dependencyNamesSet: Set<string> = new Set(this._taskSpecifier.taskDependencies || []);

      for (const dependencyName of dependencyNamesSet) {
        // Skip if we can't find the dependency
        const dependencyTask: HeftTask | undefined = this._parentPhase.tasksByName.get(dependencyName);
        if (!dependencyTask) {
          throw new Error(
            `Could not find dependency task ${JSON.stringify(dependencyName)} within phase ` +
              `${JSON.stringify(this._parentPhase.phaseName)}.`
          );
        }
        this._dependencyTasks.add(dependencyTask);
      }
    }

    return this._dependencyTasks!;
  }

  public constructor(
    parentPhase: HeftPhase,
    taskName: string,
    taskSpecifier: IHeftConfigurationJsonTaskSpecifier
  ) {
    this._parentPhase = parentPhase;
    this._taskName = taskName;
    this._taskSpecifier = taskSpecifier;

    this._validate();
  }

  public async ensureInitializedAsync(): Promise<void> {
    if (!this._taskPluginDefinition) {
      this._taskPluginDefinition = await this._loadTaskPluginDefintionAsync();
      this.pluginDefinition.validateOptions(this.pluginOptions);
    }
  }

  public async getPluginAsync(logger: IScopedLogger): Promise<IHeftTaskPlugin<object | void>> {
    await this.ensureInitializedAsync();
    if (!this._taskPlugin) {
      this._taskPlugin = await this._taskPluginDefinition!.loadPluginAsync(logger);
    }
    return this._taskPlugin;
  }

  private async _loadTaskPluginDefintionAsync(): Promise<HeftTaskPluginDefinition> {
    if (this._taskSpecifier.taskEvent && this._taskSpecifier.taskPlugin) {
      // This is validated in the schema so this shouldn't happen, but throw just in case.
      throw new Error(
        `Task ${JSON.stringify(this._taskName)} has both a taskEvent and a taskPlugin. ` +
          `Only one of these can be specified.`
      );
    }

    if (this._taskSpecifier.taskEvent) {
      switch (this._taskSpecifier.taskEvent.eventKind) {
        case 'copyFiles': {
          return _getCopyFilesPluginDefinition();
        }
        case 'deleteFiles': {
          return _getDeleteFilesPluginDefinition();
        }
        case 'runScript': {
          return _getRunScriptPluginDefinition();
        }
        case 'nodeService': {
          return _getNodeServicePluginDefinition();
        }
        default: {
          throw new InternalError(
            `Unknown task event kind ${JSON.stringify(this._taskSpecifier.taskEvent.eventKind)}`
          );
        }
      }
    } else if (this._taskSpecifier.taskPlugin) {
      // taskPlugin.pluginPackage should already be resolved to the package root.
      // See CoreConfigFiles.heftConfigFileLoader
      const pluginSpecifier: IHeftConfigurationJsonPluginSpecifier = this._taskSpecifier.taskPlugin;
      const pluginConfiguration: HeftPluginConfiguration = await HeftPluginConfiguration.loadFromPackageAsync(
        pluginSpecifier.pluginPackageRoot,
        pluginSpecifier.pluginPackage
      );
      const pluginDefinition: HeftPluginDefinitionBase =
        pluginConfiguration.getPluginDefinitionBySpecifier(pluginSpecifier);
      if (!pluginConfiguration.taskPluginDefinitions.has(pluginDefinition)) {
        throw new Error(
          `Plugin ${JSON.stringify(pluginSpecifier.pluginName)} specified by task ` +
            `${JSON.stringify(this._taskName)} is not a task plugin.`
        );
      }
      return pluginDefinition as HeftTaskPluginDefinition;
    } else {
      // This is validated in the schema so this shouldn't happen, but throw just in case
      throw new InternalError(
        `Task ${JSON.stringify(this._taskName)} has no specified task event or task plugin.`
      );
    }
  }

  private _validate(): void {
    if (RESERVED_TASK_NAMES.has(this.taskName)) {
      throw new Error(
        `Task name ${JSON.stringify(this.taskName)} is reserved and cannot be used as a task name.`
      );
    }
    if (!this._taskSpecifier.taskEvent && !this._taskSpecifier.taskPlugin) {
      throw new Error(`Task ${JSON.stringify(this.taskName)} has no specified task event or task plugin.`);
    }
  }
}
