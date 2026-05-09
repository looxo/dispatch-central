const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const SECRET_KEY = "ALPES_ITALIENNES_SECRET_2024";

let tickets       = [];
let clients       = [];
let spamMap       = {};
let ticketCounter = 0;
const SPAM_DELAY  = 30;

app.post('/ticket', (req, res) => {
  const { message, typeIntervention, position, operator, userId, time, secret, jeu } = req.body;

  if (secret !== SECRET_KEY) return res.status(403).json({ error: 'Clé invalide' });

  const now = Math.floor(Date.now() / 1000);
  if (userId && spamMap[userId] && (now - spamMap[userId]) < SPAM_DELAY) {
    return res.status(429).json({ error: 'Cooldown', reste: SPAM_DELAY - (now - spamMap[userId]) });
  }
  if (userId) spamMap[userId] = now;

  ticketCounter++;
  const ticket = {
    id:               'TKT-' + String(ticketCounter).padStart(4, '0'),
    message:          message          || 'Aucun message',
    typeIntervention: typeIntervention || '🚨 Renfort',
    position:         position         || 'Inconnue',
    operator:         operator         || 'Inconnu',
    userId:           userId           || '0',
    time:             time             || new Date().toLocaleTimeString('fr-FR'),
    jeu:              jeu              || 'Alpes Italiennes RP',
    status:           'pending',
    createdAt:        new Date().toISOString()
  };

  tickets.push(ticket);
  const payload = `data: ${JSON.stringify({ type: 'new_ticket', ticket })}\n\n`;
  clients.forEach(c => c.res.write(payload));

  console.log(`[TICKET] ${ticket.id} — ${ticket.operator} — ${ticket.typeIntervention}`);
  res.json({ success: true, ticketId: ticket.id });
});

app.post('/accept', async (req, res) => {
  const { ticketId, dispatcherName } = req.body;
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: 'Introuvable' });

  ticket.status     = 'accepted';
  ticket.acceptedBy = dispatcherName || 'Dispatch';
  ticket.acceptedAt = new Date().toISOString();

  clients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: 'ticket_accepted', ticketId })}\n\n`));
  await sendDiscordAlert(ticket);

  console.log(`[ACCEPT] ${ticketId}`);
  res.json({ success: true });
});

app.post('/refuse', (req, res) => {
  const { ticketId } = req.body;
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: 'Introuvable' });

  ticket.status    = 'refused';
  ticket.refusedAt = new Date().toISOString();

  clients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: 'ticket_refused', ticketId })}\n\n`));

  console.log(`[REFUSE] ${ticketId}`);
  res.json({ success: true });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  tickets.filter(t => t.status === 'pending').forEach(t => {
    res.write(`data: ${JSON.stringify({ type: 'new_ticket', ticket: t })}\n\n`);
  });

  const client = { id: Date.now(), res };
  clients.push(client);
  req.on('close', () => { clients = clients.filter(c => c.id !== client.id); });
});

app.get('/tickets', (req, res) => res.json(tickets));

app.get('/stats', (req, res) => res.json({
  total:    tickets.length,
  pending:  tickets.filter(t => t.status === 'pending').length,
  accepted: tickets.filter(t => t.status === 'accepted').length,
  refused:  tickets.filter(t => t.status === 'refused').length,
}));

app.get('/ping', (req, res) => res.json({ status: 'ok' }));

const ROLE_IDS = {
  '🔥 Incendie': '1502223889533501480',
  '🌲 FDF':      '1502223889533501480',
  '🚑 SAP':      '1502223772374143016',
  '🚧 SR':       '1502357390211678208',
};

const COLORS = {
  '🔥 Incendie': 16711680,
  '🚑 SAP':      3447003,
  '🚧 SR':       16776960,
  '🌲 FDF':      3394611,
  '👮 Police':   3447003,
  '🚨 Renfort':  16744272,
};

async function sendDiscordAlert(ticket) {
  const webhookUrl = process.env.WEBHOOK_GENERAL;
  if (!webhookUrl) { console.warn('[DISCORD] Webhook non configuré !'); return; }

  const roleId   = ROLE_IDS[ticket.typeIntervention];
  const pingText = roleId ? `<@&${roleId}>` : '';
  const color    = COLORS[ticket.typeIntervention] || 16744272;

  const payload = {
    content: pingText ? `${pingText} 🚨 **NOUVELLE INTERVENTION**` : '🚨 **NOUVELLE INTERVENTION**',
    embeds: [{
      title:       `${ticket.typeIntervention} — ${ticket.id}`,
      description: `**${ticket.message}**`,
      color,
      fields: [
        { name: '📍 Position',    value: ticket.position,          inline: true },
        { name: '👤 Opérateur',   value: ticket.operator,          inline: true },
        { name: '🕒 Heure',       value: ticket.time,              inline: true },
        { name: '✅ Accepté par', value: ticket.acceptedBy || '?', inline: true },
      ],
      footer:    { text: 'Dispatch Central • Alpes Italiennes RP' },
      timestamp: new Date().toISOString()
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: '✅ Pris en charge',   custom_id: `pec_${ticket.id}`     },
        { type: 2, style: 1, label: '🚗 En route',         custom_id: `route_${ticket.id}`   },
        { type: 2, style: 1, label: '📍 Sur intervention', custom_id: `sur_${ticket.id}`     },
        { type: 2, style: 4, label: '🏁 Terminée',         custom_id: `fin_${ticket.id}`     },
        { type: 2, style: 4, label: '🆘 Besoin renfort',   custom_id: `renfort_${ticket.id}` },
      ]
    }]
  };

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (res.ok) console.log(`[DISCORD] ✅ Alerte envoyée`);
    else console.error(`[DISCORD] Erreur ${res.status}`);
  } catch (e) {
    console.error('[DISCORD] Erreur réseau :', e.message);
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚨 Dispatch Central — Port ${PORT}`);
});
