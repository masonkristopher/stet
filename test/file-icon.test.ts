import { describe, expect, test } from "bun:test";

import { fileIcon, folderIcon, symlinkIcon } from "@/utils/file-icon";

describe("fileIcon", () => {
  test("matches by extension", () => {
    expect(fileIcon("main.ts")).toBe("\u{e8ca}");
    expect(fileIcon("App.tsx")).toBe("\u{e7ba}");
    expect(fileIcon("readme.css")).toBe("\u{e749}");
  });

  test("treats .mts and .cts as TypeScript", () => {
    expect(fileIcon("config.mts")).toBe("\u{e8ca}");
    expect(fileIcon("config.cts")).toBe("\u{e8ca}");
  });

  test("matches csv and http by extension", () => {
    expect(fileIcon("data.csv")).toBe("\u{e64a}");
    expect(fileIcon("requests.http")).toBe("\u{f1d8}");
  });

  test("marks NOTICE with the license glyph, like LICENSE", () => {
    expect(fileIcon("NOTICE")).toBe("\u{e60a}");
    expect(fileIcon("NOTICE")).toBe(fileIcon("LICENSE"));
  });

  test("marks license-style filenames with the license glyph, beating any extension", () => {
    expect(fileIcon("LICENSE.md")).toBe("\u{e60a}");
    expect(fileIcon("LICENSE.txt")).toBe("\u{e60a}");
    expect(fileIcon("COPYING")).toBe("\u{e60a}");
    expect(fileIcon("UNLICENSE")).toBe("\u{e60a}");
    expect(fileIcon("MIT")).toBe("\u{e60a}");
    // Creative Commons license files, including the reported CC-BY-NC-SA-4.0.
    expect(fileIcon("CC-BY-NC-SA-4.0")).toBe("\u{e60a}");
    expect(fileIcon("CC0-1.0")).toBe("\u{e60a}");
    // A License name beats its extension, not the other way around.
    expect(fileIcon("LICENSE.md")).not.toBe(fileIcon("readme.md"));
  });

  test("matches astro, pdf, and video files by extension", () => {
    expect(fileIcon("index.astro")).toBe("\u{e6b3}");
    expect(fileIcon("report.pdf")).toBe("\u{f1c1}");
    expect(fileIcon("clip.mp4")).toBe("\u{f1c8}");
    expect(fileIcon("clip.mkv")).toBe(fileIcon("clip.mp4"));
    expect(fileIcon("clip.webm")).toBe(fileIcon("clip.mp4"));
    // Webp stays an image, not a video.
    expect(fileIcon("hero.webp")).not.toBe(fileIcon("clip.mp4"));
  });

  test("shares one image glyph across image formats", () => {
    expect(fileIcon("photo.jpeg")).toBe("\u{f1c5}");
    expect(fileIcon("anim.gif")).toBe("\u{f1c5}");
    expect(fileIcon("hero.webp")).toBe("\u{f1c5}");
    expect(fileIcon("favicon.ico")).toBe("\u{f1c5}");
  });

  test("prefers an exact filename over its extension", () => {
    // Package.json is a json file, but the stem entry beats the .json extension glyph.
    expect(fileIcon("package.json")).toBe("\u{e718}");
    expect(fileIcon("package.json")).not.toBe(fileIcon("generic.json"));
    // Bunfig.toml gets the bun glyph, not the generic toml glyph.
    expect(fileIcon("bunfig.toml")).toBe("\u{e76f}");
    expect(fileIcon("bunfig.toml")).not.toBe(fileIcon("generic.toml"));
  });

  test("matches JVM source extensions", () => {
    expect(fileIcon("Main.java")).toBe("\u{e738}");
    expect(fileIcon("App.kt")).toBe("\u{e634}");
    expect(fileIcon("script.kts")).toBe("\u{e634}");
    expect(fileIcon("Build.groovy")).toBe("\u{e775}");
    expect(fileIcon("Spec.gvy")).toBe("\u{e775}");
    expect(fileIcon("App.scala")).toBe("\u{e737}");
    expect(fileIcon("worksheet.sc")).toBe("\u{e737}");
  });

  test("shares the Java glyph across compiled artifacts", () => {
    expect(fileIcon("lib.jar")).toBe(fileIcon("Main.java"));
    expect(fileIcon("Main.class")).toBe(fileIcon("Main.java"));
  });

  test("marks Gradle/Maven build files with the build glyph, beating their extension", () => {
    expect(fileIcon("build.gradle")).toBe("\u{e7f2}");
    expect(fileIcon("settings.gradle")).toBe("\u{e7f2}");
    expect(fileIcon("gradlew")).toBe("\u{e7f2}");
    expect(fileIcon("pom.xml")).toBe("\u{e674}");
    // Build.gradle.kts gets the Gradle glyph, not the .kts kotlin glyph.
    expect(fileIcon("build.gradle.kts")).toBe("\u{e7f2}");
    expect(fileIcon("build.gradle.kts")).not.toBe(fileIcon("script.kts"));
  });

  test("matches Ruby files, and peels a .rb.tmpl template to the Ruby glyph", () => {
    expect(fileIcon("Formula.rb")).toBe("\u{e739}");
    expect(fileIcon("sideye.rb.tmpl")).toBe("\u{e739}");
    expect(fileIcon("sideye.rb.tmpl")).toBe(fileIcon("Formula.rb"));
    // Only .rb.tmpl is peeled: other .tmpl files and a bare .tmpl stay generic.
    expect(fileIcon("config.yaml.tmpl")).toBe("\u{ea7b}");
    expect(fileIcon("release.tmpl")).toBe("\u{ea7b}");
  });

  test("marks .conf files with the config glyph", () => {
    expect(fileIcon("nginx.conf")).toBe("\u{e615}");
    expect(fileIcon("redis.conf")).toBe("\u{e615}");
    expect(fileIcon("nginx.conf")).toBe(fileIcon(".editorconfig"));
  });

  test("falls back to a config glyph for unmatched dotfiles", () => {
    expect(fileIcon(".editorconfig")).toBe("\u{e615}");
    expect(fileIcon(".npmrc")).toBe("\u{e615}");
    // A recognized suffix still wins over the dotfile fallback.
    expect(fileIcon(".prettierrc.json")).toBe("\u{eb0f}");
  });

  test("matches dotfiles by full name", () => {
    expect(fileIcon(".gitignore")).toBe("\u{e702}");
  });

  test("is case-insensitive", () => {
    expect(fileIcon("MAIN.TS")).toBe(fileIcon("main.ts"));
    expect(fileIcon("Dockerfile")).toBe(fileIcon("dockerfile"));
  });

  test("falls back to a generic file glyph", () => {
    expect(fileIcon("notes.xyz")).toBe("\u{ea7b}");
    expect(fileIcon("AUTHORS")).toBe("\u{ea7b}");
  });
});

describe("folderIcon", () => {
  test("reflects expanded state", () => {
    expect(folderIcon(true)).toBe("\u{f07c}");
    expect(folderIcon(false)).toBe("\u{f07b}");
    expect(folderIcon(true)).not.toBe(folderIcon(false));
  });
});

describe("symlinkIcon", () => {
  test("is the symlink glyph, independent of the target name", () => {
    expect(symlinkIcon()).toBe("\u{f481}");
    expect(symlinkIcon()).not.toBe(fileIcon("link.ts"));
  });
});
