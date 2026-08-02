# Publishing `@free-llm-router/cli`

The root router application is private on npm. Only this directory is publishable.

## 1. Verify the repository

From the repository root:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm --prefix packages/cli run build
npm --prefix packages/cli run pack:check
```

Review the dry-run file list. It must not contain `.env`, `.freellm`, logs, tests, or router-server modules.

## 2. Test the package archive

From `packages/cli`:

```powershell
npm pack
```

Install the resulting `.tgz` in a temporary directory and verify both commands:

```powershell
free-llm --version
free-llm help
```

## 3. Authenticate

```powershell
npm login
npm whoami
```

`npm whoami` must print `pr0fess0r`. Never store or commit an npm token in this repository.

## 4. Publish

```powershell
npm publish --access public
```

Expected package: `@free-llm-router/cli@0.7.0`.

## 5. Verify outside the repository

```powershell
npx --yes @free-llm-router/cli@0.7.0 --version
npx --yes @free-llm-router/cli@0.7.0 help
```

An npm version cannot be overwritten. Increment the version before every later publication.
