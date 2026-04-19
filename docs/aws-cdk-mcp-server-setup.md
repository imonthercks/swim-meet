# AWS CDK MCP Server — Setup Guide for GitHub Copilot Cloud Agents

This guide explains how to configure the **AWS CDK MCP server** so that GitHub Copilot cloud agents can use it when working on CDK tasks in this repository.

## Overview

The [AWS CDK MCP Server](https://github.com/awslabs/mcp) (`awslabs.cdk-mcp-server`) is a Python package distributed via PyPI and run using `uvx` (from the [`uv`](https://github.com/astral-sh/uv) Python package manager). It provides Model Context Protocol (MCP) tools that give AI agents access to:

- CDK construct recommendations and best practices
- CDK API guidance and property documentation
- CDK pattern suggestions
- Validation of CDK configurations

The `aws-cdk-development` skill in this repository (`.github/agents/aws-cdk-development/`) is pre-configured to use this server via the `mcp__cdk__*` tool namespace.

## Environment Setup (copilot-setup-steps.yml)

The `copilot-setup-steps.yml` workflow in this repository already installs `uv`/`uvx` and pre-caches the CDK MCP server in the Copilot cloud agent environment:

```yaml
- name: Install uv (provides uvx for running AWS MCP servers)
  uses: astral-sh/setup-uv@v6

- name: Pre-cache AWS CDK MCP server
  run: uvx awslabs.cdk-mcp-server@latest --help || true
```

When the agent invokes the CDK MCP server, it runs:
```
uvx awslabs.cdk-mcp-server@latest
```

## Enabling the Skill in Your GitHub Account

### Step 1: Merge the setup files

Ensure the following files are on your **default branch** (the `copilot-setup-steps.yml` workflow is only picked up from the default branch):

- `.github/workflows/copilot-setup-steps.yml`
- `.github/agents/aws-cdk-development/SKILL.md`
- `.github/agents/aws-mcp-setup/SKILL.md`

### Step 2: Verify the copilot-setup-steps workflow runs

1. Navigate to your repository on GitHub.
2. Click **Actions** → **Copilot Setup Steps**.
3. Click **Run workflow** to trigger a manual run.
4. Verify all steps succeed, especially **Pre-cache AWS CDK MCP server**.

### Step 3: Connect the CDK MCP server (stdio — no configuration needed)

The CDK MCP server runs as a local stdio process and requires no extra environment variables. The Copilot cloud agent invokes it automatically using:

```
uvx awslabs.cdk-mcp-server@latest
```

The `uv`/`uvx` tool is already pre-installed by the setup steps workflow. No remote endpoint or API key is required.

#### Optional: Remote MCP server (advanced)

If you want to run the CDK MCP server as a persistent remote service (e.g., on AWS Lambda or a container), you can expose it over HTTP/SSE and configure the agent to connect to it:

1. Deploy the server (see [AWS CDK MCP Server deployment docs](https://github.com/awslabs/mcp/tree/main/src/cdk-mcp-server)).
2. Store the server URL as a GitHub Actions secret named `CDK_MCP_SERVER_URL` in the `copilot` environment:

   ```
   Repository Settings → Environments → copilot → Add environment secret
   Name: CDK_MCP_SERVER_URL
   Value: https://your-cdk-mcp-server.example.com
   ```

3. The agent will use the URL when connecting to the CDK MCP server.

### Step 4: Configure AWS credentials (optional — for full AWS MCP access)

The `aws-mcp-setup` skill also supports the **Full AWS MCP Server** which can execute real AWS API calls. To enable this:

1. Create an IAM user or role with appropriate read permissions for the services you want the agent to query.
2. Store the credentials as secrets in the `copilot` environment:

   ```
   Repository Settings → Environments → copilot → Add environment secret
   Names: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
   ```

> **Security note**: Grant only the minimum permissions needed. The agent does **not** need write permissions for documentation lookup tasks. Consider using an IAM role with `ReadOnlyAccess` or a custom policy scoped to specific services.

## Verifying the Skill is Active

When you assign a CDK-related task to GitHub Copilot, you should see in the session logs:

1. **Copilot Setup Steps** running and installing dependencies.
2. The `aws-cdk-development` skill being loaded (referenced in the task description or automatically detected from the description).
3. MCP tool calls using `mcp__cdk__*` or `mcp__awsdocs__*` tool names.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Setup steps not running | `copilot-setup-steps.yml` not on default branch | Merge the workflow file to your default branch |
| CDK MCP tools not available | Binary not installed | Check the **Copilot Setup Steps** Actions run for errors |
| `mcp__cdk__*` tools missing | Skill not loaded | Ensure the task description triggers the skill; mention "CDK" or "infrastructure" |
| AWS API calls failing | No credentials | Add `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` to the `copilot` environment |
| `cdk synth` fails | Missing `googleClientId` context | Pass `--context googleClientId=<value>` or set it in `cdk.context.json` |

## References

- [AWS CDK MCP Server](https://github.com/awslabs/mcp/tree/main/src/cdk-mcp-server)
- [AWS MCP Servers](https://awslabs.github.io/mcp/)
- [GitHub Copilot cloud agent — Customizing the environment](https://docs.github.com/en/copilot/customizing-copilot/customizing-the-development-environment-for-copilot-coding-agent)
- [GitHub Copilot cloud agent — Setting environment variables](https://docs.github.com/en/copilot/customizing-copilot/customizing-the-development-environment-for-copilot-coding-agent#setting-environment-variables-in-copilots-environment)
