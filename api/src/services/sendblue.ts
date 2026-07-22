import { SendblueAPI } from "sendblue";

const client = new SendblueAPI({
  apiKey: process.env.SENDBLUE_API_KEY!,
  apiSecret: process.env.SENDBLUE_SECRET_KEY!,
});

// Claude occasionally narrates its own self-correction into the actual
// output when told "no em dashes" — e.g. drafting a line with an em dash,
// then adding "Wait, I used an em dash. Let me redo that." followed by a
// second draft, with BOTH ending up in the text. This strips that pattern
// (keeping only the final draft) and removes any em dash that slips through
// regardless, since this has now shipped to real users twice.
export function cleanCoMessage(text: string): string {
  const selfCorrection = /wait,?\s+i\s+(?:used|made|wrote)[^.]*\.\s*let\s+me\s+redo\s+that\.?\s*/i;
  const match = text.match(selfCorrection);
  const cleaned = match ? text.slice(match.index! + match[0].length) : text;
  return cleaned.replace(/—/g, ",").trim();
}

// Every message send goes through this one wrapper so cleanup applies
// uniformly, regardless of which prompt or call site generated the content.
const sendblue = {
  ...client,
  messages: {
    ...client.messages,
    send: (body: Parameters<typeof client.messages.send>[0], options?: Parameters<typeof client.messages.send>[1]) =>
      client.messages.send(
        { ...body, content: body.content ? cleanCoMessage(body.content) : body.content },
        options,
      ),
  },
} as unknown as typeof client;

export default sendblue;
