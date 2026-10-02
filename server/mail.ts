import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env.ts';

let transport: Transporter | null = null;

function getTransport(): Transporter | null {
  if (transport) return transport;
  if (env.SMTP_URL) transport = nodemailer.createTransport(env.SMTP_URL);
  else if (env.SENDMAIL) transport = nodemailer.createTransport({ sendmail: true, newline: 'unix' });
  return transport;
}

export function mailConfigured(): boolean {
  return !!(env.SMTP_URL || env.SENDMAIL);
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const t = getTransport();
  if (!t) {
    console.log(`\n[mail:console] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await t.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
}
