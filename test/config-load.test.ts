import { describe, expect, test } from "bun:test";

import { loadConfigText } from "@/config/load";
import { darkTheme } from "@/theme/dark";

describe("loadConfigText", () => {
  test("parses JSONC with comments and trailing commas", () => {
    const { config, issues } = loadConfigText(`{
      // pick a theme
      "theme": "gruvbox",
    }`);

    expect(issues).toEqual([]);
    expect(config.theme).toBe("gruvbox");
  });

  test("accepts an appearance-keyed selection pair", () => {
    const { config, issues } = loadConfigText(`{ "theme": { "dark": "a", "light": "b" } }`);

    expect(issues).toEqual([]);
    expect(config.theme).toEqual({ dark: "a", light: "b" });
  });

  test("accepts a full theme object", () => {
    const { config, issues } = loadConfigText(JSON.stringify({ themes: { mine: darkTheme } }));

    expect(issues).toEqual([]);
    expect(config.themes?.mine).toEqual(darkTheme);
  });

  test("an empty config is valid", () => {
    expect(loadConfigText("{}")).toEqual({ config: {}, issues: [] });
  });

  test("malformed JSONC falls back to defaults with an issue", () => {
    const { config, issues } = loadConfigText(`{ "theme": `);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("not valid JSONC");
  });

  test("accepts editor and ide templates", () => {
    const { config, issues } = loadConfigText(`{
      "editor": "nvim +{line} {file}",
      "ide": "code --goto {file}:{line}"
    }`);

    expect(issues).toEqual([]);
    expect(config.editor).toBe("nvim +{line} {file}");
    expect(config.ide).toBe("code --goto {file}:{line}");
  });

  test("a wrong-typed editor is rejected", () => {
    const { config, issues } = loadConfigText(`{ "editor": 42 }`);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
  });

  test("an empty editor string is rejected", () => {
    const { config, issues } = loadConfigText(`{ "editor": "" }`);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
  });

  test("a wrong-typed ide is rejected", () => {
    const { config, issues } = loadConfigText(`{ "ide": true }`);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
  });

  test("an empty ide string is rejected", () => {
    const { config, issues } = loadConfigText(`{ "ide": "" }`);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
  });

  test("a wrong-typed selection is rejected", () => {
    const { config, issues } = loadConfigText(`{ "theme": 42 }`);

    expect(config).toEqual({});
    expect(issues).toHaveLength(1);
  });
});
