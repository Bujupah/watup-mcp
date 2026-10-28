import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolList, type ToolContext } from '../tools/index.js';
import { SERVER_INSTRUCTIONS } from '../instructions.js';
import { VERSION } from '../version.js';

/** Builds an MCP server instance with all tools bound to the shared context. */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'whatsapp-mcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of toolList(ctx.requireConfirm, { calls: !!ctx.calls })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      (async (args: Record<string, unknown>) => tool.handler(args as never, ctx)) as unknown as (
        args: Record<string, unknown>,
      ) => Promise<CallToolResult>,
    );
  }
  return server;
}

/**
 * Stateless Streamable HTTP handler: each POST gets a fresh McpServer + transport. All instances share the
 * same ToolContext, so they all drive the single WhatsApp socket owned by the SessionManager.
 */
export function mcpPostHandler(ctx: ToolContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      ctx.logger.error({ err }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}

export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST).' }, id: null });
}
