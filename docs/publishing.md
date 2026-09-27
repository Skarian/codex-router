# Publishing to npm

The package name is `@skarian/codex-router`. Its installed command is `codex-router`.
The public package uses the MIT license.

## Package contents

Git tracks source, tests, examples, and documentation. It ignores all of `dist`.
The npm package contains compiled runtime files, documentation, and the ESP32 example.
It excludes TypeScript tests, development dependencies, and local configuration.

The `prepare` script builds the project during a source install, `npm pack`, or `npm publish`.
Registry users receive compiled JavaScript. They do not need TypeScript or a source build.
The `prepublishOnly` script runs the automated tests before publication.
See the [npm lifecycle reference](https://docs.npmjs.com/cli/v11/using-npm/scripts/) for script order.

## Verify a release

Use a clean checkout so obsolete build files cannot enter the package.

```sh
npm ci
npm test
npm pack --dry-run
npm pack
```

Inspect the package list. It must contain `dist/src/cli.js`, the runtime modules, `README.md`, and `LICENSE`.
It must not contain `dist/test`, credentials, private keys, or local gateway state.
The [npm package file rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files) define the allowlist behavior.

Install the generated archive in a temporary global prefix:

```sh
npm install --global --prefix /absolute/path/to/test-prefix ./skarian-codex-router-0.1.0.tgz
```

Use the archive name for the selected version.
On macOS and Linux, the executable is under `<prefix>/bin/codex-router`.
On Windows, use `<prefix>\codex-router.cmd`.

Run `agents list --json` with an isolated configuration through that executable.
Verify a gateway startup with temporary state before using the package with a live configuration.
Do not start a second gateway against an existing state directory.

## Publish

Authenticate as an npm user with access to the `@skarian` scope:

```sh
npm login
npm whoami
```

Commit the verified source and documentation before publishing.
For later releases, select a new version with `npm version patch`, `minor`, or `major` before the final package checks.
The first release uses `0.1.0`.

```sh
npm publish --access public
npm view @skarian/codex-router version
```

Complete the npm authentication prompt if required.
The repository sets public access and the npm registry in `publishConfig`.
Keep npm tokens outside the repository.

Push the release commit and its tag when applicable.
