---
name: aws-mcp-setup
description: Configure AWS MCP servers for documentation search and API access. Use when setting up AWS MCP, configuring AWS documentation tools, troubleshooting MCP connectivity, or when user mentions aws-mcp, awsdocs, uvx setup, or MCP server configuration. Covers both Full AWS MCP Server (with uvx + credentials) and lightweight Documentation MCP (no auth required).
allowed-tools:
  - Bash(which *)
  - Bash(aws sts get-caller-identity*)
  - Bash(claude mcp *)
  - Bash(cat *mcp.json*)
  - Bash(cat *claude.json*)
---

# AWS MCP Server Configuration Guide

## Overview

This guide helps you configure AWS MCP tools for AI agents. Two options are available:

| Option | Requirements | Capabilities |
|--------|--------------|--------------|
| **Full AWS MCP Server** | Python 3.10+, uvx, AWS credentials | Execute AWS API calls + documentation search |
| **AWS Documentation MCP** | None | Documentation search only |

## Step 1: Check Existing Configuration

Before configuring, check if AWS MCP tools are already available:

Look for these tool name patterns in the agent's available tools:
- `mcp__aws-mcp__*` or `mcp__aws__*` → Full AWS MCP Server configured
- `mcp__*awsdocs*__aws___*` → AWS Documentation MCP configured

## Step 2: Choose Configuration Method

### Automatic Detection

Run these commands to determine which option to use:

```bash
# Check for uvx (requires Python 3.10+)
which uvx || echo "uvx not available"

# Check for valid AWS credentials
aws sts get-caller-identity || echo "AWS credentials not configured"
```

### Option A: Full AWS MCP Server (Recommended)

**Use when**: uvx available AND AWS credentials valid

**Configuration** (add to your MCP settings):
```json
{
  "mcpServers": {
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata", "AWS_REGION=us-west-2"
      ]
    }
  }
}
```

### Option B: AWS Documentation MCP Server (No Auth)

**Use when**: No Python/uvx environment or no AWS credentials needed

**Configuration**:
```json
{
  "mcpServers": {
    "awsdocs": {
      "type": "http",
      "url": "https://knowledge-mcp.global.api.aws"
    }
  }
}
```

## Step 3: Verification

After configuration, verify tools are available:

**For Full AWS MCP**:
- Look for tools: `mcp__aws-mcp__aws___search_documentation`, `mcp__aws-mcp__aws___call_aws`

**For Documentation MCP**:
- Look for tools: `mcp__awsdocs__aws___search_documentation`, `mcp__awsdocs__aws___read_documentation`

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `uvx: command not found` | uv not installed | Install with `pip install uv` or use Option B |
| `AccessDenied` error | Missing IAM permissions | Add aws-mcp:* permissions to IAM policy |
| `InvalidSignatureException` | Credential issue | Check `aws sts get-caller-identity` |
| Tools not appearing | MCP not started | Restart your agent after config change |
