# JavaScript reference

This folder preserves the validated JavaScript version of the sample. The
repository root is the primary TypeScript implementation.

Run the JavaScript tests from this folder:

```powershell
npm ci
npm test
```

Build its Linux AMD64 image with this folder as the Docker context:

```powershell
docker buildx build `
  --platform linux/amd64 `
  --file .\node24.Dockerfile `
  --tag flex-container-node-html-to-pdf:javascript `
  --load `
  --provenance=false `
  .
```
