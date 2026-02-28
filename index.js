require('dotenv').config();
const express = require('express');
const cors = require('cors');
const personasRouter = require('./api/personas');
const parchesRouter = require('./api/parches');

const app = express();

app.use(cors());
app.use(express.json());

// Rutas
app.use('/api/personas', personasRouter);
app.use('/api/parches', parchesRouter);

// Ruta raíz
app.get('/', (_req, res) => {
  res.json({ message: 'Backend Fall API - Ranking Infieles UTS' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

module.exports = app;
