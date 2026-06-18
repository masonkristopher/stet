# Changelog

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
