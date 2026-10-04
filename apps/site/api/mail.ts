const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.RESEND_FROM ?? "DxxpCode <licenses@dxxp.codes>";

export function mailReady() {
  return Boolean(RESEND_KEY);
}

// Sends the buyer their license key via the Resend REST API (no SDK dep).
export async function sendLicenseEmail(to: string, licenseKey: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject: "Your DxxpCode license",
      text: `Your lifetime license key:\n\n${licenseKey}\n\nIn the app, run:\n\n/license ${licenseKey}\n\nKeep this email — the key is not shown anywhere else.\n`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}
