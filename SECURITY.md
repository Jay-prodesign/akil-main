# Security Policy

AKILTA Core is currently a private engineering repository and is not represented
by this repository as a production/customer-facing service.

## Reporting a security issue

Do not disclose suspected vulnerabilities, secrets, customer data, access
tokens, exploit details, or other sensitive security information in a public
issue, public discussion, or public pull request.

Use an authorized private project/security channel available to repository
owners and maintainers. If GitHub private vulnerability reporting/security
advisories are enabled for this repository, that private channel is preferred.

Include, where safely possible:

- affected commit, branch, component, or release;
- impact and affected boundary;
- minimal reproduction steps;
- whether credentials, personal data, tenant isolation, authorization, or
  irreversible effects may be involved;
- any evidence needed to reproduce the issue without exposing real secrets.

## Secret handling

Real credentials, passwords, API keys, tokens, private keys, session material,
or customer secrets must not be committed to the repository, task records,
prompts, fixtures, or ordinary logs.

Use placeholders and approved secret-management boundaries. Suspected committed
secrets must be treated as compromised and rotated through the appropriate
provider/account authority; deleting the file alone is not sufficient.

## Security claims

Repository documentation, tests, or types are not proof of production security.
Security/privacy claims must match real deployed behavior and evidence.

Before a materially public or commercial release, review at minimum:

- authentication/session and authorization boundaries;
- tenant/customer/project isolation;
- protected-action and approval/currentness controls;
- secret storage and connection boundaries;
- logging, audit, retention, deletion, export, and telemetry behavior;
- dependency and supply-chain evidence;
- deployment/runtime configuration and recovery behavior;
- public privacy/security claims against the actual implementation.

## Supported versions

There is no generally supported public production version declared by this
repository at this time. Release-specific support and disclosure information
must be published when a public/commercial release actually exists.
