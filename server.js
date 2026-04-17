import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
app.use(express.static('.'));

app.post('/api/transcribe', async (req, res) => {
  const { videoId } = req.body;
  console.log('Procesando:', videoId);

  try {
    // 1. Transcribir directamente con AssemblyAI + YouTube URL
    console.log('Enviando a AssemblyAI...');
    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': process.env.ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: `https://www.youtube.com/watch?v=${videoId}`,
        language_detection: true,
        speech_models: ['universal-2'],
      }),
    });
    const submitData = await submitRes.json();
    console.log('AssemblyAI submit:', JSON.stringify(submitData).substring(0, 200));
    if (submitData.error) throw new Error('AssemblyAI error: ' + submitData.error);
    const transcriptId = submitData.id;

    // 2. Esperar transcripción
    let transcript = null;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'Authorization': process.env.ASSEMBLYAI_KEY },
      });
      const pollData = await pollRes.json();
      console.log('Estado:', pollData.status);
      if (pollData.status === 'completed') {
        transcript = pollData;
        break;
      } else if (pollData.status === 'error') {
        throw new Error('AssemblyAI error: ' + pollData.error);
      }
    }
    if (!transcript) throw new Error('Timeout esperando transcripción');

    // 3. Traducir al español con Groq
    console.log('Traduciendo...');
    const words = transcript.words || [];
    const segments = [];
    let chunk = [];

    for (const word of words) {
      chunk.push(word);
      if (chunk.length >= 20 || word.text.includes('.') || word.text.includes(',')) {
        const text = chunk.map(w => w.text).join(' ');
        const start = chunk[0].start / 1000;
        const end = chunk[chunk.length - 1].end / 1000;

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama3-8b-8192',
            messages: [
              { role: 'system', content: 'Traduce del catalán al español. Responde solo con la traducción, sin explicaciones.' },
              { role: 'user', content: text }
            ],
            max_tokens: 200,
          }),
        });
        const groqData = await groqRes.json();
        const translated = groqData.choices?.[0]?.message?.content || text;
        segments.push({ start, end, text: translated });
        chunk = [];
      }
    }

    console.log('Segmentos:', segments.length);
    res.json({ segments });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
