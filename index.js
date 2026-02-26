require('dotenv').config();
const express = require('express');
const cors = require('cors');
const personasRouter = require('./api/personas');

const app = express();

app.use(cors());
app.use(express.json());

// Rutas
app.use('/api/personas', personasRouter);

// Ruta raíz
app.get('/', (_req, res) => {
  res.json({ message: 'Backend Fall API - Ranking Infieles UTS' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

module.exports = app;
