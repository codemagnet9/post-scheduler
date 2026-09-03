// src/notifications/email.ts
// Email behind an interface. Production uses Resend; tests use FakeEmailProvider (records, no I/O,
// no console — so tokens can never leak to logs). The Resend client is loaded lazily so the SDK is
// only required when actually configured.
//
// DNS the client must set on the sending domain for delivery to work (request these EARLY):
//   - SPF:   a TXT record authorizing the provider, e.g. "v=spf1 include:_spf.resend.com ~all"
//   - DKIM:  the CNAME/TXT records Resend generates for the domain (public key) — signs every message
//   - DMARC: a TXT at _dmarc, e.g. "v=DMARC1; p=none; rua=mailto:dmarc@<domain>" (tighten to
//            quarantine/reject once aligned). Without SPF+DKIM aligned, mail lands in spam or bounces.
//   - Return-Path / MAIL FROM CNAME if using a custom bounce subdomain.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dep (resend), namespace intentionally loose
const dyn = (m: string): Promise<any> => import(m);

export class ResendEmailProvider implements EmailProvider {
  constructor(private apiKey: string, private from: string) {}
  async send(msg: EmailMessage): Promise<void> {
    const { Resend } = await dyn('resend');
    const client = new Resend(this.apiKey);
    const { error } = await client.emails.send({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    if (error) throw new Error(`resend: ${JSON.stringify(error)}`);
  }
}

export class FakeEmailProvider implements EmailProvider {
  public sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

let current: EmailProvider = new FakeEmailProvider();
export function getEmailProvider(): EmailProvider {
  return current;
}
export function setEmailProvider(p: EmailProvider): void {
  current = p;
}
