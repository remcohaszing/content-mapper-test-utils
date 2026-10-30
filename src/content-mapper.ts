import type { InitializeParams, TransformParams } from 'content-mapper-test-utils'

import type {
  CloseProjectParams,
  InitializeResult,
  OpenProjectParams,
  OpenProjectResult,
  TransformResult
} from './protocol.js'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { includeKeys } from 'filter-obj'
// eslint-disable-next-line import-x/no-extraneous-dependencies
import typescript from 'typescript'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node'

/**
 * Get a file-like path as a real path.
 *
 * @param pathOrUrl
 *   The path or file URL.
 * @returns
 *   The path as a string.
 */
function asFilePath(pathOrUrl: string | URL): string {
  return typeof pathOrUrl === 'string' ? pathOrUrl : fileURLToPath(pathOrUrl)
}

/**
 * Assert a value is an object.
 *
 * @param value
 *   The value to assert.
 */
function assertObject(value: unknown): asserts value is Record<PropertyKey, unknown> {
  assert.ok(typeof value === 'object' && value != null)
}

/**
 * Assert a value is an array of strings.
 *
 * @param value
 *   The value to assert.
 */
function assertStringArray(value: unknown): asserts value is string[] {
  assert.ok(Array.isArray(value))
  for (const item of value) {
    assert.ok(typeof item === 'string')
  }
}

interface Project extends AsyncDisposable {
  /**
   * The result from the `openProject` call.
   */
  openProjectResult: OpenProjectResult

  /**
   * Transform a file.
   *
   * @param fileName
   *   The file name to transform.
   * @param content
   *   The file content to transform.
   * @returns
   *   The result of the transform call.
   */
  transform: (fileName: string, content: string) => Promise<TransformResult>
}

interface ContentMapper extends Disposable {
  /**
   * Kill the content mapper process.
   */
  dispose: () => undefined

  /**
   * The result of the `initialize` call.
   */
  initializeResult: InitializeResult

  /**
   * Open a project.
   *
   * @param tsconfig
   *   The path to a TypeScript project or the project directory.
   */
  openProject: (tsconfig: string | URL) => Promise<Project>
}

export namespace createContentMapper {
  export interface Options {
    /**
     * Override the `exec` field of the content mapper.
     */
    exec?: string[] | undefined

    /**
     * Set an explicit locale.
     */
    locale?: string | undefined
  }
}

/**
 * Create a typed content mapper process.
 *
 * @param packageJson
 *   The path to the `package.json` file of the content mapper.
 * @param options
 *   Additional options.
 * @returns
 *   A typed content mapper API.
 */
export async function createContentMapper(
  packageJson: string | URL,
  options?: createContentMapper.Options
): Promise<ContentMapper> {
  const packagePath = asFilePath(packageJson)
  const packageDir = dirname(packagePath)
  const packageString = await readFile(packagePath, 'utf8')
  const pkg: unknown = JSON.parse(packageString)

  assertObject(pkg)
  assertObject(pkg.typescript)
  assertObject(pkg.typescript.contentMapper)
  assertStringArray(pkg.typescript.contentMapper.exec)
  assertStringArray(pkg.typescript.contentMapper.compilerOptions)
  const { compilerOptions, exec } = pkg.typescript.contentMapper
  assert.ok(typeof pkg.name === 'string')
  assert.ok(typeof pkg.version === 'string')
  assert.ok(exec.length > 1)

  let projectCount = 0
  const projectHandlePrefix = `${pkg.name}@${pkg.version}:`
  const [command, ...args] = options?.exec || exec
  const proc = spawn(command, args, {
    cwd: packageDir,
    stdio: ['pipe', 'pipe', 'inherit']
  })

  /**
   * Kill the process.
   */
  function dispose(): undefined {
    proc.kill()
  }

  const connection = createMessageConnection(
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin)
  )

  connection.listen()

  const initializeResult = await connection.sendRequest<InitializeResult>('initialize', {
    // eslint-disable-next-line unicorn/text-encoding-identifier-case
    positionEncodings: ['utf-8', 'utf-16'],
    locale: options?.locale
  } satisfies InitializeParams)

  return {
    initializeResult,
    dispose,

    async openProject(tsconfig) {
      const projectHandle = projectHandlePrefix + projectCount
      projectCount += 1
      let tsconfigFileName = asFilePath(tsconfig)
      if ((await stat(tsconfigFileName)).isDirectory()) {
        tsconfigFileName = join(tsconfigFileName, 'tsconfig.json')
      }
      const configSourceFile = typescript.readJsonConfigFile(
        tsconfigFileName,
        typescript.sys.readFile
      )
      const { options: tsOptions, raw } = typescript.parseJsonSourceFileConfigFileContent(
        configSourceFile,
        typescript.sys,
        dirname(tsconfigFileName),
        undefined,
        tsconfigFileName
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapperSetup = (raw.contentMappers as any[]).find(
        (contentMapper) => contentMapper.package === pkg.name
      )

      const openProjectResult = await connection.sendRequest<OpenProjectResult>('openProject', {
        projectHandle,
        options: mapperSetup.options,
        compilerOptions: includeKeys(tsOptions, compilerOptions),
        configFileName: tsconfigFileName
      } satisfies OpenProjectParams)

      return {
        openProjectResult,

        transform(fileName, content) {
          return connection.sendRequest('transform', {
            content,
            fileName,
            projectHandle
          } satisfies TransformParams)
        },

        async [Symbol.asyncDispose]() {
          await connection.sendRequest<CloseProjectParams>('closeProject', { projectHandle })
        }
      }
    },

    [Symbol.dispose]() {
      dispose()
    }
  }
}
