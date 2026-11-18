import { Fragment } from "react";

// Render the commonly used GitLab Markdown subset as React elements, never raw HTML.
function inline(text, depth = 0) {
  if (depth > 12) return text;
  const tokens = /\\(?<escape>[\\`*_{}\[\]()#+.!>~\-])|(?<code>`+)(?<codeText>[^`]*?)\k<code>|\*\*\*(?<bothText>\S(?:[\s\S]*?\S)?)\*\*\*|\*\*(?<boldText>\S(?:[\s\S]*?\S)?)\*\*(?!\*)|(?<![\p{L}\p{N}])__(?<underBoldText>\S(?:[\s\S]*?\S)?)__(?![\p{L}\p{N}_])|~~(?<strike>\S(?:[\s\S]*?\S)?)~~|\*(?<italicText>\S(?:[\s\S]*?\S)?)\*(?!\*)|(?<![\p{L}\p{N}])_(?<underItalicText>\S(?:[\s\S]*?\S)?)_(?![\p{L}\p{N}_])|\[(?<label>[^\]\n]+)\]\((?<url><[^>\n]+>|(?:[^\s()]|\([^()]*\))+)(?:\s+"[^"\n]*")?\)|(?<newline>\n)/gu;
  const result = [];
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    result.push(text.slice(start, match.index));
    const group = match.groups;
    let element;
    if (group.escape) element = group.escape;
    else if (group.code) element = <code>{group.codeText}</code>;
    else if (group.bothText) element = <strong><em>{inline(group.bothText, depth + 1)}</em></strong>;
    else if (group.boldText || group.underBoldText) element = <strong>{inline(group.boldText || group.underBoldText, depth + 1)}</strong>;
    else if (group.strike) element = <del>{inline(group.strike, depth + 1)}</del>;
    else if (group.italicText || group.underItalicText) element = <em>{inline(group.italicText || group.underItalicText, depth + 1)}</em>;
    else if (group.url) {
      const url = group.url.replace(/^<|>$/g, "");
      element = /^(?:https?:\/\/|mailto:|#|\/(?!\/))/i.test(url) && !/[\u0000-\u0020\\]/.test(url)
        ? <a href={url} target="_blank" rel="noreferrer">{inline(group.label, depth + 1)}</a> : match[0];
    } else element = <br/>;
    result.push(<Fragment key={match.index}>{element}</Fragment>);
    start = match.index + match[0].length;
  }
  result.push(text.slice(start));
  return result;
}

const listItem = (line) => line.match(/^( *)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
const fenceStart = (line) => line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
const heading = (line) => line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
const rule = (line) => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const blockStart = (line) => fenceStart(line) || heading(line) || rule(line) || listItem(line) || /^ {0,3}>/.test(line);

// Parse nested lists and quotations in bounded recursion; unsupported syntax stays readable.
function blocks(lines, depth = 0) {
  if (depth > 12) return <p>{lines.join("\n")}</p>;
  const result = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const key = index;
    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      index++;
      while (index < lines.length) {
        const closing = fenceStart(lines[index]);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length && !closing[2].trim()) { index++; break; }
        content.push(lines[index++]);
      }
      result.push(<pre key={key}><code>{content.join("\n")}</code></pre>);
      continue;
    }
    const title = heading(line);
    if (title) {
      const Heading = `h${title[1].length}`;
      result.push(<Heading key={key}>{inline(title[2])}</Heading>); index++; continue;
    }
    if (rule(line)) { result.push(<hr key={key}/>); index++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quoted.push(lines[index++].replace(/^ {0,3}> ?/, ""));
      result.push(<blockquote key={key}>{blocks(quoted, depth + 1)}</blockquote>); continue;
    }
    const firstItem = listItem(line);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[2]), indent = firstItem[1].length, items = [];
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const itemLines = [item[4]], contentIndent = indent + item[2].length + 1;
        index++;
        while (index < lines.length && lines[index].trim() && /^ +/.test(lines[index]) && lines[index].match(/^ */)[0].length > indent) {
          itemLines.push(lines[index].slice(Math.min(contentIndent, lines[index].match(/^ */)[0].length))); index++;
        }
        const checklist = item[3] !== undefined;
        items.push(<li key={items.length} className={checklist ? "markdown-check-item" : undefined}>
          {checklist && <input type="checkbox" checked={item[3].toLowerCase() === "x"} disabled readOnly aria-label={item[4]}/>}
          {blocks(itemLines, depth + 1)}
        </li>);
      }
      const List = ordered ? "ol" : "ul";
      result.push(<List key={key} start={ordered ? parseInt(firstItem[2], 10) : undefined}>{items}</List>); continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) paragraph.push(lines[index++]);
    // GitLab hard-break markers should not be displayed as literal punctuation.
    result.push(<p key={key}>{inline(paragraph.join("\n").replace(/ {2,}(?=\n)|\\(?=\n)/g, ""))}</p>);
  }
  return result;
}

export default function MarkdownBody({ text = "", className = "" }) {
  return <div className={`markdown-body ${className}`}>{blocks(text.replace(/\r\n?/g, "\n").split("\n"))}</div>;
}
