/**
 * Anthropic ⇄ journal adapter: maps the provider's native `MessageParam`
 * array to the provider-neutral {@link JournalMessage} format and back
 * (docs/message-journal.md).
 *
 * Invariant (round trip): for every array this provider produces,
 * `fromJournalMessages(arr.map(toJournal))` is send-equivalent — string
 * content becomes a single text block, `cache_control` / `citations` are
 * dropped (the loop re-stamps cache breakpoints per request), and every
 * thinking signature, tool_use input, and FULL tool_result payload survives.
 *
 * Lossy on purpose: blocks the journal has no kind for (`search_result`,
 * `server_tool_use`, `web_search_tool_result`, `container_upload`, …) are
 * recorded as a labelled text block so the audit record keeps their content;
 * on resume they replay as text, which the API always accepts.
 *
 * @module agent/providers/anthropic-direct/journal-adapter
 */

import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources';
import type {
  JournalAdapter,
  JournalBinary,
  JournalBlock,
  JournalMessage,
  JournalResultPart,
} from '../../journal/index.js';
import { filterContentBlocks } from './resolve-params.js';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type ResultContentBlock = Exclude<ToolResultBlockParam['content'], string | undefined>[number];

// ─── native → journal ────────────────────────────────────────────────────────

function fallbackText(block: { type: string }): { type: 'text'; text: string } {
  const { type, ...rest } = block as Record<string, unknown> & { type: string };
  delete rest['cache_control'];
  return { type: 'text', text: `[${type}] ${JSON.stringify(rest)}` };
}

function imageToJournal(block: ImageBlockParam): JournalBlock & { type: 'image' } {
  const s = block.source;
  const source: JournalBinary =
    s.type === 'base64' ? { kind: 'base64', mediaType: s.media_type, data: s.data } : { kind: 'url', url: s.url };
  return { type: 'image', source };
}

/** Documents: PDFs stay binary; plain-text and content-sourced documents become text. */
function documentToJournal(block: DocumentBlockParam): JournalResultPart {
  const s = block.source;
  const title = block.title ?? undefined;
  const withTitle = (text: string): string => (title ? `[document: ${title}]\n${text}` : text);
  if (s.type === 'text') return { type: 'text', text: withTitle(s.data) };
  if (s.type === 'content') {
    const text = typeof s.content === 'string'
      ? s.content
      : s.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
    return { type: 'text', text: withTitle(text) };
  }
  const source: JournalBinary =
    s.type === 'base64' ? { kind: 'base64', mediaType: s.media_type, data: s.data } : { kind: 'url', url: s.url };
  return { type: 'document', source, ...(title ? { title } : {}) };
}

function resultPartToJournal(block: ResultContentBlock): JournalResultPart {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') return imageToJournal(block);
  if (block.type === 'document') return documentToJournal(block);
  return fallbackText(block);
}

function toolResultToJournal(block: ToolResultBlockParam): JournalBlock {
  const c = block.content;
  const content: JournalResultPart[] =
    c === undefined ? [] : typeof c === 'string' ? [{ type: 'text', text: c }] : c.map(resultPartToJournal);
  return {
    type: 'tool_result',
    toolUseId: block.tool_use_id,
    ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
    content,
  };
}

function blockToJournal(block: ContentBlockParam): JournalBlock {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'thinking': return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    case 'redacted_thinking': return { type: 'redacted_thinking', data: block.data };
    case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result': return toolResultToJournal(block);
    case 'image': return imageToJournal(block);
    case 'document': return documentToJournal(block);
    default: return fallbackText(block);
  }
}

// ─── journal → native ────────────────────────────────────────────────────────

function binaryFallback(label: string, title?: string): TextBlockParam {
  return { type: 'text', text: `[${label}${title ? `: ${title}` : ''} unavailable on resume]` };
}

function imageFromJournal(source: JournalBinary): ImageBlockParam | TextBlockParam {
  if (source.kind === 'base64') {
    return { type: 'image', source: { type: 'base64', media_type: source.mediaType as ImageMediaType, data: source.data } };
  }
  if (source.kind === 'url') return { type: 'image', source: { type: 'url', url: source.url } };
  return binaryFallback('image');
}

function documentFromJournal(source: JournalBinary, title?: string): DocumentBlockParam | TextBlockParam {
  const t = title !== undefined ? { title } : {};
  if (source.kind === 'url') return { type: 'document', source: { type: 'url', url: source.url }, ...t };
  if (source.kind === 'base64') {
    if (source.mediaType === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: source.data }, ...t };
    }
    if (source.mediaType.startsWith('text/')) {
      const text = Buffer.from(source.data, 'base64').toString('utf8');
      return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, ...t };
    }
  }
  return binaryFallback('document', title);
}

function resultPartFromJournal(part: JournalResultPart): ResultContentBlock {
  switch (part.type) {
    case 'text': return { type: 'text', text: part.text };
    case 'text_ref': return { type: 'text', text: part.preview };
    case 'image': return imageFromJournal(part.source);
    case 'document': return documentFromJournal(part.source, part.title);
  }
}

/** Returns `null` for blocks this provider cannot replay (unsigned thinking). */
function blockFromJournal(block: JournalBlock): ContentBlockParam | null {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text };
    case 'text_ref': return { type: 'text', text: block.preview };
    case 'thinking':
      // Cross-provider thinking has no Anthropic signature; the API rejects it.
      return block.signature ? { type: 'thinking', thinking: block.thinking, signature: block.signature } : null;
    case 'redacted_thinking': return { type: 'redacted_thinking', data: block.data };
    case 'tool_use': return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
        ...(block.content.length > 0 ? { content: block.content.map(resultPartFromJournal) } : {}),
      };
    case 'image': return imageFromJournal(block.source);
    case 'document': return documentFromJournal(block.source, block.title);
  }
}

function messageFromJournal(message: JournalMessage): MessageParam | null {
  const blocks = message.content.map(blockFromJournal).filter((b): b is ContentBlockParam => b !== null);
  // Final shape guard shared with the legacy resume path.
  const content = filterContentBlocks(blocks);
  return content.length > 0 ? { role: message.role, content } : null;
}

/** The anthropic-direct {@link JournalAdapter}. Stateless; share one instance. */
export const anthropicJournalAdapter: JournalAdapter<MessageParam> = {
  toJournal(message: MessageParam): JournalMessage {
    const content: JournalBlock[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(blockToJournal);
    return { role: message.role, content };
  },

  fromJournalMessages(messages: readonly JournalMessage[]): MessageParam[] {
    const out: MessageParam[] = [];
    for (const m of messages) {
      const native = messageFromJournal(m);
      if (!native) continue;
      const prev = out[out.length - 1];
      // Anthropic requires role alternation: merge consecutive same-role
      // messages (cross-provider journals, or a message emptied above).
      if (prev && prev.role === native.role) {
        prev.content = [...(prev.content as ContentBlockParam[]), ...(native.content as ContentBlockParam[])];
      } else {
        out.push(native);
      }
    }
    return out;
  },
};
