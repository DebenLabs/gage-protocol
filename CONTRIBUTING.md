# Contributing

Open a pull request describing the concrete behavior changed and the relevant verification. Keep unrelated changes separate. Use the pinned toolchain and commands in the README.

Contributions to Gage's original code are submitted under the repository's MIT license. Preserve third-party licenses and attribution. Contract source files need the matching SPDX header.

Do not commit environment files, signing material, real user data, database exports, raw logs or generated broadcast artifacts. Use placeholder configuration and synthetic fixtures. The publication and secret-scanning checks run in CI; exceptions must identify the specific public value or deliberate test fixture and explain why it is safe.

Report vulnerabilities through SECURITY.md rather than a public issue or pull request.
