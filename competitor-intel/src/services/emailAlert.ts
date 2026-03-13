import nodemailer from 'nodemailer';
import { SELF, ALL_ENTITIES, type Article } from '../config/competitors.js';
import { getUnalertedNegativeArticles, markAlerted, getArticlesForEntity, getAllEntitiesWithCustom } from './blobStore.js';

/** Escape untrusted strings for safe HTML embedding */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function markAlertedAll(articles: Article[]): Promise<void> {
  const byEntity = new Map<string, string[]>();
  for (const a of articles) {
    if (!byEntity.has(a.entity_id)) byEntity.set(a.entity_id, []);
    byEntity.get(a.entity_id)!.push(a.id);
  }
  for (const [entityId, ids] of byEntity) {
    await markAlerted(entityId, ids);
  }
}

function getSmtpConfig() {
  const host = Netlify.env.get('SMTP_HOST');
  const user = Netlify.env.get('SMTP_USER');
  const pass = Netlify.env.get('SMTP_PASS');
  if (!host || !user || !pass) return null;

  return {
    host,
    port: parseInt(Netlify.env.get('SMTP_PORT') || '587'),
    secure: false,
    auth: { user, pass },
  };
}

function buildAlertHtml(articles: Article[]): string {
  const rows = articles.map(a => {
    const safeLink = escapeHtml(a.link || '');
    const safeTitle = escapeHtml(a.title || '');
    const safeSource = escapeHtml(a.source || '');
    const safeSnippet = escapeHtml(a.snippet ? a.snippet.substring(0, 200) + '...' : '');
    const safeLabel = escapeHtml(a.sentiment_label || '');
    const pubDate = (() => { try { return new Date(a.pub_date).toLocaleDateString(); } catch { return 'N/A'; } })();
    return `
    <tr>
      <td style="padding:8px; border-bottom:1px solid #eee;">
        <a href="${safeLink}" style="color:#c0392b; font-weight:bold;">${safeTitle}</a>
        <br><span style="color:#888; font-size:12px;">${safeSource} | ${pubDate}</span>
        <br><span style="font-size:13px; color:#333;">${safeSnippet}</span>
        <br><span style="color:#c0392b; font-size:11px;">Sentiment: ${a.sentiment_score} (${safeLabel})</span>
      </td>
    </tr>
  `;
  }).join('');

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #c0392b; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin:0;">Negative Article Alert</h2>
        <p style="margin:4px 0 0; opacity:0.9;">The Dobbs Group - Competitor Intelligence</p>
      </div>
      <div style="padding: 16px 24px; background: #fff; border: 1px solid #ddd;">
        <p>The following negative article(s) mentioning <strong>The Dobbs Group</strong> have been detected:</p>
        <table style="width:100%; border-collapse:collapse;">${rows}</table>
        <p style="margin-top:16px; font-size:13px; color:#666;">
          Review these articles promptly. This is an automated alert from your Competitor Intelligence system.
        </p>
      </div>
      <div style="padding:12px 24px; background:#f5f5f5; border-radius: 0 0 8px 8px; border:1px solid #ddd; border-top:none;">
        <p style="margin:0; font-size:11px; color:#999; text-align:center;">
          Competitor Intel Dashboard | The Dobbs Group | Graystone Consulting
        </p>
      </div>
    </div>
  `;
}

export async function checkAndAlertNegativeArticles(): Promise<{
  sent: boolean;
  reason?: string;
  articles?: number;
  to?: string;
}> {
  // Gather negative articles about self + priority interest rate articles from all entities
  const negativeArticles = await getUnalertedNegativeArticles(SELF.id);

  const allEntities = await getAllEntitiesWithCustom();
  const priorityArticles: Article[] = [];
  for (const entity of allEntities) {
    const entityArticles = await getArticlesForEntity(entity.id);
    const unalertedPriority = entityArticles.filter(a => a.priority === true && !a.alerted);
    priorityArticles.push(...unalertedPriority);
  }

  const articles = [...negativeArticles, ...priorityArticles.filter(
    p => !negativeArticles.some(n => n.id === p.id)
  )];

  if (articles.length === 0) {
    return { sent: false, reason: 'No new negative or priority articles' };
  }

  console.log(`[ALERT] Found ${negativeArticles.length} negative + ${priorityArticles.length} priority article(s)`);

  const smtp = getSmtpConfig();
  if (!smtp) {
    console.log('[ALERT] SMTP not configured - articles left unalerted for future delivery');
    return { sent: false, reason: 'SMTP not configured', articles: articles.length };
  }

  const alertTo = Netlify.env.get('ALERT_TO') || '';
  const alertFrom = Netlify.env.get('ALERT_FROM') || smtp.auth.user;

  if (!alertTo) {
    console.log('[ALERT] ALERT_TO not set - articles left unalerted for future delivery');
    return { sent: false, reason: 'ALERT_TO not set', articles: articles.length };
  }

  try {
    const transporter = nodemailer.createTransport(smtp);
    await transporter.sendMail({
      from: alertFrom,
      to: alertTo,
      subject: `ALERT: Negative Article About The Dobbs Group (${articles.length} article${articles.length > 1 ? 's' : ''})`,
      html: buildAlertHtml(articles),
    });

    await markAlertedAll(articles);
    console.log(`[ALERT] Email sent to ${alertTo} with ${articles.length} article(s)`);
    return { sent: true, to: alertTo, articles: articles.length };
  } catch (err: any) {
    console.error(`[ALERT] Failed to send email: ${err.message}`);
    return { sent: false, reason: err.message, articles: articles.length };
  }
}
