/**
 * Shared agentic loop helper.
 * Handles the Claude tool-use loop: call API → execute tools → repeat until end_turn.
 */

const Anthropic = require('@anthropic-ai/sdk');

let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in environment variables.');
    }
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Run an agentic loop.
 * @param {object} opts
 * @param {string}   opts.system        - System prompt
 * @param {Array}    opts.messages      - Initial messages array [{role, content}]
 * @param {Array}    opts.tools         - Claude tool definitions
 * @param {object}   opts.toolHandlers  - { toolName: async (input) => result }
 * @param {number}   [opts.maxTurns=8]  - Max loop iterations
 * @param {number}   [opts.maxTokens]   - Max output tokens
 * @returns {Promise<string>} Final text response
 */
async function runAgent({ system, messages, tools = [], toolHandlers = {}, maxTurns = 8, maxTokens = 1024 }) {
  const client = getClient();
  const history = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: maxTokens,
      system,
      tools,
      messages: history,
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    }

    // Append assistant response (may contain text + tool_use blocks)
    history.push({ role: 'assistant', content: response.content });

    // Execute any requested tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        const handler = toolHandlers[block.name];
        if (!handler) throw new Error(`No handler registered for tool: ${block.name}`);
        result = await handler(block.input);
      } catch (err) {
        console.error(`Tool "${block.name}" failed:`, err.message);
        result = `Error: ${err.message}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      });
    }

    if (toolResults.length === 0) break;
    history.push({ role: 'user', content: toolResults });
  }

  return 'Unable to complete the request.';
}

module.exports = { runAgent };
