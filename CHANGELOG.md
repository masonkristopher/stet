# Changelog

## [0.3.0](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.10...sideye-v0.3.0) (2026-06-26)


### ⚠ BREAKING CHANGES

* 💥 y in the viewer copies path:line only; the line's code snippet is no longer appended.

### Features

* ✨  copy file path from the file tree ([#110](https://github.com/jimmy-guzman/sideye/issues/110)) ([cf33923](https://github.com/jimmy-guzman/sideye/commit/cf33923f63c7a58422ef89c7eaea110aea9865bf))
* **theme:** ✨ runtime theme switcher ([#112](https://github.com/jimmy-guzman/sideye/issues/112)) ([6d15a9d](https://github.com/jimmy-guzman/sideye/commit/6d15a9d2bf680ded85af09d1bea73c476b30d8d2))


### Bug Fixes

* **theme:** 🐛 render focused overlay input text in theme color ([#116](https://github.com/jimmy-guzman/sideye/issues/116)) ([535e83d](https://github.com/jimmy-guzman/sideye/commit/535e83d294f2eb0d3e23692a8ddb01799efa4f60))


### Performance Improvements

* **refresh:** ⚡️cut refresh load & harden exit/startup ([#115](https://github.com/jimmy-guzman/sideye/issues/115)) ([cbddb1f](https://github.com/jimmy-guzman/sideye/commit/cbddb1f30dd33059de9f56d3109141761e2e6413))

## [0.2.10](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.9...sideye-v0.2.10) (2026-06-25)


### Features

* **config:** ✨ user config w/ custom themes & live following ([#106](https://github.com/jimmy-guzman/sideye/issues/106)) ([8f69b90](https://github.com/jimmy-guzman/sideye/commit/8f69b9007788207ee2869f10ba1dfff4a0bb72d8))
* **icons:** ✨ add icons for .csv, .http & NOTICE ([#105](https://github.com/jimmy-guzman/sideye/issues/105)) ([d30d93a](https://github.com/jimmy-guzman/sideye/commit/d30d93a22d6fc6e2d566d57a3cf92adc485e0839)), closes [#95](https://github.com/jimmy-guzman/sideye/issues/95)
* **input:** ✨ add mouse navigation across panes & overlays ([#99](https://github.com/jimmy-guzman/sideye/issues/99)) ([616596c](https://github.com/jimmy-guzman/sideye/commit/616596cd0ce2c79b0f72bbdbf0aa3dba12382c04))
* **scopes:** ✨ add session & last-commit scopes behind a picker ([#102](https://github.com/jimmy-guzman/sideye/issues/102)) ([35e987a](https://github.com/jimmy-guzman/sideye/commit/35e987acf166bc9903bc20b3a520a45b8ea3a11a))
* **title:** ✨ set terminal title for tab bars ([#98](https://github.com/jimmy-guzman/sideye/issues/98)) ([a0c8439](https://github.com/jimmy-guzman/sideye/commit/a0c8439dcc6fae8947152f3e376801461296e204))


### Bug Fixes

* **theme:** 🐛 darken active diff line in light mode ([#104](https://github.com/jimmy-guzman/sideye/issues/104)) ([5436999](https://github.com/jimmy-guzman/sideye/commit/5436999cb739f1b315f4e85bebbe58c12e26712e))
* **viewer:** 🐛 keep whole-file view scrolled to the change after toggling ([#93](https://github.com/jimmy-guzman/sideye/issues/93)) ([ffd19ef](https://github.com/jimmy-guzman/sideye/commit/ffd19ef4aaaaf61601271972975e22efc6c8f18d))
* **worktree:** 🐛 defer full-tree load when switching worktrees ([#103](https://github.com/jimmy-guzman/sideye/issues/103)) ([843d4e9](https://github.com/jimmy-guzman/sideye/commit/843d4e91517f163150b26c9820f90bde375823dd))

## [0.2.9](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.8...sideye-v0.2.9) (2026-06-24)


### Features

* **problems:** ✨ group diagnostics by file w/ aligned columns ([#92](https://github.com/jimmy-guzman/sideye/issues/92)) ([ed927ae](https://github.com/jimmy-guzman/sideye/commit/ed927ae848d9f5559d676ffd811fa1d5acb02685))
* **theme:** ✨ new palette, fix diff current-line/diagnostic cues ([#87](https://github.com/jimmy-guzman/sideye/issues/87)) ([73e29de](https://github.com/jimmy-guzman/sideye/commit/73e29dec4d1c27ba09fa6a833f3f3e79e02eac84))
* **tree:** ✨ highlight Gradle files and add JVM file-type icons ([#91](https://github.com/jimmy-guzman/sideye/issues/91)) ([1331cc8](https://github.com/jimmy-guzman/sideye/commit/1331cc8daa5185f0fd4b980e8234d87b9cca5658))


### Bug Fixes

* **viewer:** 🐛 follow the cursor with a scroll-off margin ([#89](https://github.com/jimmy-guzman/sideye/issues/89)) ([e8e0000](https://github.com/jimmy-guzman/sideye/commit/e8e000082d2e00a75fce6416966621babca83628))

## [0.2.8](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.7...sideye-v0.2.8) (2026-06-24)


### Features

* **theme:** ✨ adopt a Catppuccin-grounded, pink-forward palette ([#80](https://github.com/jimmy-guzman/sideye/issues/80)) ([8dd26c3](https://github.com/jimmy-guzman/sideye/commit/8dd26c3fd465380554e21a946670853e0f0a82e6))
* **tree:** ✨ broaden file-icon coverage ([#83](https://github.com/jimmy-guzman/sideye/issues/83)) ([ab18a9e](https://github.com/jimmy-guzman/sideye/commit/ab18a9e5e93b4cdff3dce297761d6e1fa3d47437))
* **tree:** ✨ render symlinks as their target path ([#84](https://github.com/jimmy-guzman/sideye/issues/84)) ([59afe2d](https://github.com/jimmy-guzman/sideye/commit/59afe2defef11a4075e5019d0d34048e16e49182))
* **ui:** ✨ vanish the scrollbar track into its surface ([#85](https://github.com/jimmy-guzman/sideye/issues/85)) ([549f9fd](https://github.com/jimmy-guzman/sideye/commit/549f9fd910bdf2150567c4e6abf8fa595e09ab1d))


### Bug Fixes

* **sidebar:** 🐛 stop the file tree scrollbox from hijacking arrow keys ([#86](https://github.com/jimmy-guzman/sideye/issues/86)) ([384e77f](https://github.com/jimmy-guzman/sideye/commit/384e77fdfd5da783804cbc5ea474933503139b72))
* **viewer:** 🐛 stop wheel scroll from blanking the lower viewport ([#82](https://github.com/jimmy-guzman/sideye/issues/82)) ([f303def](https://github.com/jimmy-guzman/sideye/commit/f303defc65b4a137950fd4fccc7bd839bec3bb8c))

## [0.2.7](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.6...sideye-v0.2.7) (2026-06-23)


### Features

* **diff:** ✨ highlight any Shiki language on demand ([#77](https://github.com/jimmy-guzman/sideye/issues/77)) ([4bc180f](https://github.com/jimmy-guzman/sideye/commit/4bc180fc131f4733c96802db11d39a2ac7c9a508))
* **ui:** ✨ quiet the visual language & follow the terminal theme ([#79](https://github.com/jimmy-guzman/sideye/issues/79)) ([667b604](https://github.com/jimmy-guzman/sideye/commit/667b604b76f185a6c2210219f6aaf91b903554eb))

## [0.2.6](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.5...sideye-v0.2.6) (2026-06-23)


### Features

* **viewer:** ✨ own the diff renderer on @pierre/diffs and Shiki ([#75](https://github.com/jimmy-guzman/sideye/issues/75)) ([96524b7](https://github.com/jimmy-guzman/sideye/commit/96524b7bed5ec7a0a646b460d4c86945cd3fe5fe))

## [0.2.5](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.4...sideye-v0.2.5) (2026-06-20)


### Features

* **worktree:** ✨ recover when the active worktree is deleted ([#72](https://github.com/jimmy-guzman/sideye/issues/72)) ([394cdd1](https://github.com/jimmy-guzman/sideye/commit/394cdd10ef01c8aa340eccc17deb26b48b145180))


### Bug Fixes

* **git:** 🐛 force canonical a//b/ diff prefixes ([#74](https://github.com/jimmy-guzman/sideye/issues/74)) ([a555b34](https://github.com/jimmy-guzman/sideye/commit/a555b34c29afc8e52724b62f98ba4ed0cc113ec3))

## [0.2.4](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.3...sideye-v0.2.4) (2026-06-17)


### Features

* **viewer:** ✨ toggleable word wrap for long lines ([#69](https://github.com/jimmy-guzman/sideye/issues/69)) ([03c240a](https://github.com/jimmy-guzman/sideye/commit/03c240a48369d762e48e0eab71da2f7bf3505c82))

## [0.2.3](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.2...sideye-v0.2.3) (2026-06-17)


### Features

* **git:** ✨ refresh from a filesystem watcher ([#68](https://github.com/jimmy-guzman/sideye/issues/68)) ([245b315](https://github.com/jimmy-guzman/sideye/commit/245b3158bd4f89d03911c0a342e9cd3bb70e6e79))
* **sidebar:** ✨ resize the sidebar width with [ / ] / \ ([#66](https://github.com/jimmy-guzman/sideye/issues/66)) ([bf0f62e](https://github.com/jimmy-guzman/sideye/commit/bf0f62ef4a9ea893adebc230cb891ae396f8eb45))

## [0.2.2](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.1...sideye-v0.2.2) (2026-06-16)


### Features

* **diagnostics:** ✨ add oxlint findings alongside typescript ([#53](https://github.com/jimmy-guzman/sideye/issues/53)) ([4d2413b](https://github.com/jimmy-guzman/sideye/commit/4d2413b61cacd39ea2e852df651626e2190d48e3))
* **find:** ✨ add in-buffer find (/) to the viewer ([#55](https://github.com/jimmy-guzman/sideye/issues/55)) ([b8149f1](https://github.com/jimmy-guzman/sideye/commit/b8149f1cf6d2f37a742e61a4ec1aa8dad24426dc))
* **search:** ✨ add project content search (ctrl-f) ([#56](https://github.com/jimmy-guzman/sideye/issues/56)) ([117c797](https://github.com/jimmy-guzman/sideye/commit/117c797b38ee54dcee6590b0f2594f197df9b360))

## [0.2.1](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.2.0...sideye-v0.2.1) (2026-06-15)


### Bug Fixes

* **git:** 🐛 prevent index.lock conflicts with concurrent git processes ([#50](https://github.com/jimmy-guzman/sideye/issues/50)) ([b6ccf1a](https://github.com/jimmy-guzman/sideye/commit/b6ccf1a156de82e30968323ed29eca52320c9873))
* **quit:** 🐛 exit instantly on ctrl-c ([#52](https://github.com/jimmy-guzman/sideye/issues/52)) ([303d089](https://github.com/jimmy-guzman/sideye/commit/303d0898e4b1e8cb9a3bfefe404cfbdb97225ce7))

## [0.2.0](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.7...sideye-v0.2.0) (2026-06-15)


### ⚠ BREAKING CHANGES

* **diagnostics:** 💥 Diagnostics are now powered by an LSP

### Features

* **diagnostics:** ✨ to an auto provisioning LSP client ([#46](https://github.com/jimmy-guzman/sideye/issues/46)) ([ef0024b](https://github.com/jimmy-guzman/sideye/commit/ef0024b50bc343f3221c90f7b5842c20c6006a3c))
* **tree:** ✨ add Nerd Font file-type icons to the file tree ([#44](https://github.com/jimmy-guzman/sideye/issues/44)) ([c87bb13](https://github.com/jimmy-guzman/sideye/commit/c87bb13e7ddbfc62e8bf805d3e6e3cdfd391d00c))


### Bug Fixes

* **checker:** 🐛 run checkers via the repo's package manager ([#41](https://github.com/jimmy-guzman/sideye/issues/41)) ([ba6c0ab](https://github.com/jimmy-guzman/sideye/commit/ba6c0abcfb573e4105d85883c78d94833cfba8a4))

## [0.1.7](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.6...sideye-v0.1.7) (2026-06-14)


### Features

* **ui:** ✨ mute scrollbars to theme colors ([#39](https://github.com/jimmy-guzman/sideye/issues/39)) ([2601e12](https://github.com/jimmy-guzman/sideye/commit/2601e1237445639a6b91aa0928321a30f787952b))


### Bug Fixes

* **file:** 🐛 classify deleted binaries on the git-show path ([#36](https://github.com/jimmy-guzman/sideye/issues/36)) ([74db41a](https://github.com/jimmy-guzman/sideye/commit/74db41a4ff144c99548c0914fc895205bfea5a87))
* **syntax:** 🐛 highlight JSX with the tsx grammar ([#38](https://github.com/jimmy-guzman/sideye/issues/38)) ([d3b3555](https://github.com/jimmy-guzman/sideye/commit/d3b355504e8eb0d7cf8b04535b7a07aad2841d6d))
* **ui:** 🐛 stop the tree-navigation freeze w/ solidjs ([#33](https://github.com/jimmy-guzman/sideye/issues/33)) ([4a5c7c4](https://github.com/jimmy-guzman/sideye/commit/4a5c7c40a9f97eec251635dc27b78f9215fd6b6b))

## [0.1.6](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.5...sideye-v0.1.6) (2026-06-12)


### Features

* **ui:** ✨ display version in header ([#21](https://github.com/jimmy-guzman/sideye/issues/21)) ([77a7a43](https://github.com/jimmy-guzman/sideye/commit/77a7a43054f122d37d07d1e3cd31e6123b98b241))
* **ui:** ✨ switch git worktrees with w key ([#23](https://github.com/jimmy-guzman/sideye/issues/23)) ([8294122](https://github.com/jimmy-guzman/sideye/commit/82941224d0602ff4ab81d47741c38510c89a7c56))

## [0.1.5](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.4...sideye-v0.1.5) (2026-06-12)


### Features

* **diagnostics:** ✨ support monorepo workspace typecheck discovery ([#11](https://github.com/jimmy-guzman/sideye/issues/11)) ([dfd44ff](https://github.com/jimmy-guzman/sideye/commit/dfd44ff9ab0a11b50acafa0cdb103c1595ac2cda))
* **ui:** ✨ smart truncate tree names preserving extension ([#18](https://github.com/jimmy-guzman/sideye/issues/18)) ([deea032](https://github.com/jimmy-guzman/sideye/commit/deea032b46ef4cf772556b913c240e25cb119a5d))
* **ui:** ✨ surface activity on collapsed directories ([#15](https://github.com/jimmy-guzman/sideye/issues/15)) ([61e4984](https://github.com/jimmy-guzman/sideye/commit/61e4984336cd181125951ea9740167eadd918414))
* **ui:** ✨ toggle file tree sidebar with b key ([#19](https://github.com/jimmy-guzman/sideye/issues/19)) ([1c22761](https://github.com/jimmy-guzman/sideye/commit/1c22761170ea98722058f2ea799d945e9ffae9ff))


### Bug Fixes

* **install:** 🐛 add sideye bin to PATH automatically ([#14](https://github.com/jimmy-guzman/sideye/issues/14)) ([ef4df03](https://github.com/jimmy-guzman/sideye/commit/ef4df031d1e02c0d9f1161c2a471014644642a69))
* **ui:** 🐛 reserve badge space when tree rows ([#20](https://github.com/jimmy-guzman/sideye/issues/20)) ([049fdd4](https://github.com/jimmy-guzman/sideye/commit/049fdd4b4428513923ab347d0d98dc29dfccf186))


### Performance Improvements

* ⚡️ defer repo file enumeration to after initial render ([#13](https://github.com/jimmy-guzman/sideye/issues/13)) ([e123e23](https://github.com/jimmy-guzman/sideye/commit/e123e230a134f4a27af034ce314d1901e86a2b05))
* **lint:** ⚡️ enable perf oxlint rules ([#16](https://github.com/jimmy-guzman/sideye/issues/16)) ([c0d313c](https://github.com/jimmy-guzman/sideye/commit/c0d313c263b5ea7754def59759533cd2359dbafe))

## [0.1.4](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.3...sideye-v0.1.4) (2026-06-11)


### Performance Improvements

* ⚡️ two-tier polling to reduce ls-files frequency on large repos ([#8](https://github.com/jimmy-guzman/sideye/issues/8)) ([4e4372f](https://github.com/jimmy-guzman/sideye/commit/4e4372f9c96199d34537f5c6d28bf91568cf5bef))

## [0.1.3](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.2...sideye-v0.1.3) (2026-06-11)


### Bug Fixes

* 🐛 pass NPM_TOKEN to npm publish step ([#6](https://github.com/jimmy-guzman/sideye/issues/6)) ([81014cf](https://github.com/jimmy-guzman/sideye/commit/81014cf503058f9fc9da641a03c52aaa196745f0))

## [0.1.2](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.1...sideye-v0.1.2) (2026-06-11)


### Bug Fixes

* 🐛 exclude CHANGELOG.md from oxfmt checks ([#4](https://github.com/jimmy-guzman/sideye/issues/4)) ([9806c2b](https://github.com/jimmy-guzman/sideye/commit/9806c2b2ebd33beec646298340413002bec1fd11))

## [0.1.1](https://github.com/jimmy-guzman/sideye/compare/sideye-v0.1.0...sideye-v0.1.1) (2026-06-11)


### Features

* ✨ initial version of `sideye` ([#2](https://github.com/jimmy-guzman/sideye/issues/2)) ([e70c3a7](https://github.com/jimmy-guzman/sideye/commit/e70c3a78b190fb5d5a0a40e8737a88a752a475b5))
