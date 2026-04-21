import z from "zod"
import { Effect } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Instance } from "../project/instance"

const id = "ingest-design-docs"

const parameters = z.object({
  run_id: z.string().describe("The run id for the current AutoCrew run. Used to scope the output state directory."),
  folder: z
    .string()
    .describe("Path to a folder of markdown design documents. Defaults to 'autocrew-design-docs/' if not provided.")
    .optional(),
  files: z
    .array(z.string())
    .describe("Optional explicit list of file paths to ingest (relative to the project root). Overrides 'folder'.")
    .optional(),
})

interface Section {
  filename: string
  bytes: number
}

const DESCRIPTION = `Ingest AutoCrew design documents. Reads markdown files from a folder (or an explicit list), concatenates them with section markers, and writes the result to .opencode/autocrew-state/{run_id}/design-docs.md. Returns a structured summary of what was ingested. Call this once at the start of an AutoCrew run before dispatching any workers.`

export const IngestDesignDocsTool = Tool.define(
  id,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const run = Effect.fn("IngestDesignDocsTool.execute")(function* (
      params: z.infer<typeof parameters>,
      _ctx: Tool.Context,
    ) {
      const cwd = Instance.directory

      // Resolve the file list.
      let absFiles: string[] = []
      if (params.files && params.files.length > 0) {
        absFiles = params.files.map((f) => (path.isAbsolute(f) ? f : path.join(cwd, f)))
      } else {
        const folder = params.folder ?? "autocrew-design-docs"
        const absFolder = path.isAbsolute(folder) ? folder : path.join(cwd, folder)
        const exists = yield* fs.exists(absFolder).pipe(Effect.orDie)
        if (!exists) {
          return {
            title: `Ingest design docs (${folder})`,
            metadata: {
              runId: params.run_id,
              fileCount: 0,
              totalBytes: 0,
              outputPath: "",
              error: `Folder not found: ${absFolder}`,
            },
            output: JSON.stringify(
              {
                run_id: params.run_id,
                folder,
                error: `Folder not found: ${absFolder}`,
                file_count: 0,
                total_bytes: 0,
                sections: [],
              },
              null,
              2,
            ),
          }
        }
        const matches = Glob.scanSync("**/*.md", {
          cwd: absFolder,
          absolute: true,
          dot: false,
          symlink: true,
        })
        absFiles = matches.sort()
      }

      // Read each file.
      const sections: Section[] = []
      const parts: string[] = []
      let totalBytes = 0
      for (const absPath of absFiles) {
        const text = yield* fs.readFileString(absPath).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (text === undefined) continue
        const rel = path.relative(cwd, absPath)
        const bytes = Buffer.byteLength(text, "utf8")
        sections.push({ filename: rel, bytes })
        totalBytes += bytes
        parts.push(`\n\n---\n\n## From: ${rel}\n\n${text.trimEnd()}\n`)
      }

      // Write the concatenated output.
      const stateDir = path.join(cwd, ".opencode", "autocrew-state", params.run_id)
      yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.orDie)
      const outputPath = path.join(stateDir, "design-docs.md")
      const header = `# AutoCrew Design Docs (run: ${params.run_id})\n\nIngested ${sections.length} file${sections.length === 1 ? "" : "s"}, ${totalBytes} bytes total.`
      yield* fs.writeFileString(outputPath, header + parts.join("")).pipe(Effect.orDie)

      const summary = {
        run_id: params.run_id,
        output_path: outputPath,
        file_count: sections.length,
        total_bytes: totalBytes,
        sections,
      }

      return {
        title: `Ingested ${sections.length} design docs`,
        metadata: {
          runId: params.run_id,
          fileCount: sections.length,
          totalBytes,
          outputPath,
          error: "",
        },
        output: JSON.stringify(summary, null, 2),
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
