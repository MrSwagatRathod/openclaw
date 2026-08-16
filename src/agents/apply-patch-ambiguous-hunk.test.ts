/**
 * Regression tests for openclaw#124392.
 * The whitespace/punctuation-tolerant fallback in the update-hunk seek used to
 * return the first lookalike match, silently applying a hunk to the wrong block.
 * Tolerant matches must now be unique or be refused.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdateHunk } from "./apply-patch-update.js";
import { applyPatch } from "./apply-patch.test-support.js";

type Chunk = Parameters<typeof applyUpdateHunk>[1][number];

function chunk(overrides: Partial<Chunk>): Chunk {
  return {
    oldLines: [],
    newLines: [],
    contextOldIndexes: [],
    isEndOfFile: false,
    ...overrides,
  };
}

/**
 * Two blocks holding the same statements at different nesting depths. Tabs make
 * the indentation differ from the space-indented patch text below, which is what
 * forces the tolerant fallback to run.
 */
function handlersSource(earlyCall: string): string {
  return [
    "def handle_early(payload):",
    "\tif payload:",
    `\t\t${earlyCall}`,
    "\t\treturn None",
    "",
    "",
    "def handle_target(payload):",
    "\tfor item in payload:",
    "\t\tif item:",
    "\t\t\tflush()",
    "\t\t\treturn None",
    "",
  ].join("\n");
}

// Deletion-only: with no "+" lines nothing depends on how inserted lines are
// written, so the only variable under test is where the hunk landed.
const deleteFlushPair = [chunk({ oldLines: ["            flush()", "            return None"] })];

describe("apply_patch tolerant matching ambiguity (openclaw#124392)", () => {
  it("refuses a tolerant hunk that matches more than one block", async () => {
    await expect(
      applyUpdateHunk("handlers.py", deleteFlushPair, {
        readFile: async () => handlersSource("flush()"),
      }),
    ).rejects.toThrow(/Found 2 occurrences of these lines in handlers\.py/);
  });

  it("names the ambiguity and asks for more context, like the edit tool does", async () => {
    await expect(
      applyUpdateHunk("handlers.py", deleteFlushPair, {
        readFile: async () => handlersSource("flush()"),
      }),
    ).rejects.toThrow(/The lines must be unique\. Please include surrounding context lines/);
  });

  it("still applies a tolerant hunk when only one block matches", async () => {
    const result = await applyUpdateHunk("handlers.py", deleteFlushPair, {
      readFile: async () => handlersSource("flush_early()"),
    });

    // The intended (deeply nested) block loses its body; the earlier block stays.
    expect(result).toContain("\t\tflush_early()");
    expect(result).not.toContain("\t\t\tflush()");
    expect(result).toContain("def handle_target(payload):");
  });

  it("keeps first-match-wins for exactly quoted repeated blocks", async () => {
    // Exact matches address their target unambiguously, so repeated identical
    // blocks must stay editable rather than becoming unreachable.
    const source = ["flush()", "return None", "flush()", "return None", ""].join("\n");
    const result = await applyUpdateHunk("repeat.py", [chunk({ oldLines: ["flush()"] })], {
      readFile: async () => source,
    });

    expect(result).toBe(["return None", "flush()", "return None", ""].join("\n"));
  });

  it("reports an ambiguous @@ context marker instead of claiming it is missing", async () => {
    // The marker only matches after the tolerant pass strips indentation, and it
    // matches both blocks. That is an ambiguity, not a missing context line.
    const source = [
      "class Reader:",
      "\tdef flush(self):",
      "\t\treturn None",
      "",
      "class Writer:",
      "\tdef flush(self):",
      "\t\treturn None",
      "",
    ].join("\n");

    await expect(
      applyUpdateHunk(
        "streams.py",
        [chunk({ changeContext: "def flush(self):", oldLines: ["        return None"] })],
        { readFile: async () => source },
      ),
    ).rejects.toThrow(
      /Found 2 occurrences of context 'def flush\(self\):' in streams\.py\. The context must be unique\. Please use a more specific @@ context line\./,
    );
  });

  it("still resolves a tolerant @@ context marker when it matches one line", async () => {
    const source = [
      "class Reader:",
      "\tdef read(self):",
      "\t\treturn None",
      "",
      "class Writer:",
      "\tdef flush(self):",
      "\t\treturn None",
      "",
    ].join("\n");

    const result = await applyUpdateHunk(
      "streams.py",
      [chunk({ changeContext: "def flush(self):", oldLines: ["        return None"] })],
      { readFile: async () => source },
    );

    // Only the Writer block loses its body; the Reader block is untouched.
    expect(result).toBe(
      [
        "class Reader:",
        "\tdef read(self):",
        "\t\treturn None",
        "",
        "class Writer:",
        "\tdef flush(self):",
        "",
      ].join("\n"),
    );
  });

  it("leaves the file untouched when the patch is refused", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-amb-")));
    try {
      const file = path.join(dir, "handlers.py");
      const before = handlersSource("flush()");
      await fs.writeFile(file, before);

      const patch = `*** Begin Patch
*** Update File: ${file}
@@
-            flush()
-            return None
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/occurrences/);
      expect(await fs.readFile(file, "utf8")).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
