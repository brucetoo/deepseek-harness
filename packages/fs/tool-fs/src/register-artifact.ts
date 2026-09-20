/** Register an existing binary or externally generated file as a deliverable. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { sessionResolveOptions } from './session-cwd.ts'

interface RegisterArtifactArgs {
  path: string
}

/**
 * Register the existing-file check, replayable location, and model guidance.
 * @param ctx - Agent context carrying filesystem, prompt, and Tool services.
 */
export function applyRegisterArtifactTool(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:register-artifact',
    order: 103,
    text: 'After another tool or script creates a binary deliverable, call register_artifact with its exact path.',
  })
  ctx.tools.register(defineTool({
    name: 'register_artifact',
    description: 'Register an existing regular file as a completed user deliverable.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Existing file path, resolved relative to the current workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<type>artifact</type>\n<content>\nRegistered deliverable\n</content>`,
      }],
    },
    async execute(args: RegisterArtifactArgs, exec) {
      if (args.path.trim() === '') throw new Error('path must be a non-empty string')
      const target = await ctx.fs.resolve(args.path, sessionResolveOptions(exec, args.path))
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot register "${args.path}": file not found`)
      if (info.type !== 'file') throw new Error(`cannot register "${args.path}": not a regular file`)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: args.path,
        ...(info.size === undefined ? {} : { bytes: info.size }),
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Register ${args.path}`,
        kind: 'edit',
        locations: [{ path: args.path }],
      }
    },
  }))
}
