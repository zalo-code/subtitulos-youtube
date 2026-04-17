export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { videoId } = req.body;

  try {
    // 1. Iniciar descarga
    const mp3Res = await fetch(
      `https://youtube-info-download-api.p.rapidapi.com/ajax/download.php?format=mp3&add_info=0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&audio_quality=128&allow_extended_duration=1&no_merge=false&audio_language=en`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        }
      }
    );
    const mp3Data = await mp3Res.json();
    
    // Log para debug
    console.log('MP3 response:', JSON.stringify(mp3Data));
    
    const progressUrl = mp3Data.progress_url;
    if (!progressUrl) throw new Error('Sin progress_url. Respuesta: ' + JSON.stringify(mp3Data));

    // 2. Esperar hasta que el audio esté listo
    let audioUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const progressRes = await fetch(progressUrl);
      const progressData = await progressRes.json();
      console.log('Progress:', JSON.stringify(progressData));
      
      if (progressData.url) { audioUrl = progressData.url; break; }
      if (progressData.download_url) { audioUrl = progressData.download_url; break; }
      if (progressData.content) { audioUrl = progressData.content; break; }
    }
    if (!audioUrl) throw new Error('Timeout esperando el audio');

    // 3. Descargar el audio
    const audioRes = await fetch(audioUrl);
    const audioBuffer = await audioRes.arrayBuffer();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });

    // 4. Transcribir con Groq Whisper
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'ca');
    formData.append('task', 'translate');
    formData.append('response_format', 'verbose_json');

    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: formData,
      }
    );
    const groqData = await groqRes.json();
    res.status(200).json({ segments: groqData.segments });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
