/**
 * Converts Anthropic Messages response to OpenAI Chat Completions response.
 */
import { extractInputTokens, extractOutputTokens } from '../../cache';

export function formatAnthropicToOpenAI(response: any, model: string): any {
  const content = response.content || [];

  let textContent = "";
  const toolCalls: any[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message: any = { role: "assistant" };

  if (textContent) {
    message.content = textContent;
  } else {
    message.content = null;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: response.stop_reason === "tool_use" ? "tool_calls"
                     : response.stop_reason === "max_tokens" ? "length"
                     : "stop",
      },
    ],
    usage: response.usage
      ? (() => {
          const input = extractInputTokens(response.usage);
          const output = extractOutputTokens(response.usage);
          return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
        })()
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
