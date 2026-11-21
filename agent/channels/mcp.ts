import { mcpChannel } from 'eve/channels/mcp'
import { spikeAuth } from '../lib/spike-auth'

/** The agent as an MCP server, with its tools published (`tools: true`) so a client can call them without the model. */
export default mcpChannel({ auth: spikeAuth, tools: true })
