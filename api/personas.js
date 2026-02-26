const express = require('express');
const { getPool } = require('../lib/db');

const router = express.Router();

// ─── Helper: obtener posición real calculada por total_votos DESC ────────────
async function buildLeaderboard(conn, whereClause = '', params = []) {
  const [rows] = await conn.execute(
    `SELECT
       p.id,
       p.nombre,
       p.carrera,
       p.edad,
       p.genero,
       p.semestre,
       r.total_votos AS total,
       r.medalla     AS medal,
       GROUP_CONCAT(ra.descripcion SEPARATOR ', ') AS razon
     FROM ranking r
     JOIN personas p  ON r.persona_id = p.id
     LEFT JOIN razones ra ON ra.persona_id = p.id
     ${whereClause}
     GROUP BY p.id, p.nombre, p.carrera, p.edad, p.genero, p.semestre, r.total_votos, r.medalla
     ORDER BY r.total_votos DESC, p.nombre ASC`,
    params
  );

return rows.map((row, i) => ({
    pos: i + 1,
    id: row.id,
    nombre: row.nombre,
    carrera: row.carrera,
    edad: row.edad,
    genero: row.genero || 'desconocido',
    semestre: row.semestre,
    total: row.total,
    razon: row.razon || null,
    medal: row.medal || '',
  }));
}

// ─── GET /api/personas  →  leaderboard completo ─────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const conn = getPool();
    const leaderboard = await buildLeaderboard(conn);
    res.json({ success: true, data: leaderboard });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── GET /api/personas/:id  →  una persona con su posición real ─────────────
router.get('/:id', async (req, res) => {
  try {
    const conn = getPool();
    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === parseInt(req.params.id, 10));
    if (!persona) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }
    res.json({ success: true, data: persona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── POST /api/personas  →  registrar (crea o incrementa) ───────────────────
router.post('/', async (req, res) => {
  try {
    const { nombre, edad, carrera, razon } = req.body;
    if (!nombre || !edad || !carrera) {
      return res.status(400).json({ success: false, data: null, error: 'nombre, edad y carrera son requeridos' });
    }

    const conn = getPool();

    // Buscar si ya existe por nombre (case-insensitive)
    const [existing] = await conn.execute(
      'SELECT id FROM personas WHERE LOWER(nombre) = LOWER(?)',
      [nombre]
    );

    let personaId;

    if (existing.length > 0) {
      personaId = existing[0].id;
      // Incrementar votos
      await conn.execute(
        'UPDATE ranking SET total_votos = total_votos + 1 WHERE persona_id = ?',
        [personaId]
      );
      // Agregar razón si se proporcionó
      if (razon) {
        await conn.execute(
          'INSERT INTO razones (persona_id, descripcion) VALUES (?, ?)',
          [personaId, razon]
        );
      }
    } else {
      // Crear nueva persona
      const [insertP] = await conn.execute(
        'INSERT INTO personas (nombre, carrera, edad) VALUES (?, ?, ?)',
        [nombre, carrera, edad]
      );
      personaId = insertP.insertId;

      // Calcular posición (última)
      const [countRows] = await conn.execute('SELECT COUNT(*) AS total FROM ranking');
      const newPos = countRows[0].total + 1;

      await conn.execute(
        'INSERT INTO ranking (posicion, persona_id, total_votos, medalla) VALUES (?, ?, 1, ?)',
        [newPos, personaId, '']
      );

      if (razon) {
        await conn.execute(
          'INSERT INTO razones (persona_id, descripcion) VALUES (?, ?)',
          [personaId, razon]
        );
      }
    }

    // Actualizar medallas
    await updateMedals(conn);

    // Devolver la persona actualizada
    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === personaId);
    res.json({ success: true, data: persona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── PUT /api/personas/:id  →  actualizar campos ────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nombre, edad, carrera, total, razon } = req.body;
    const conn = getPool();

    // Verificar existencia
    const [check] = await conn.execute('SELECT id FROM personas WHERE id = ?', [id]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }

    // Actualizar persona
    const updates = [];
    const values = [];
    if (nombre !== undefined) { updates.push('nombre = ?'); values.push(nombre); }
    if (edad !== undefined)   { updates.push('edad = ?');   values.push(edad); }
    if (carrera !== undefined) { updates.push('carrera = ?'); values.push(carrera); }

    if (updates.length > 0) {
      values.push(id);
      await conn.execute(`UPDATE personas SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    if (total !== undefined) {
      await conn.execute('UPDATE ranking SET total_votos = ? WHERE persona_id = ?', [total, id]);
    }

    if (razon !== undefined) {
      await conn.execute(
        'INSERT INTO razones (persona_id, descripcion) VALUES (?, ?)',
        [id, razon]
      );
    }

    await updateMedals(conn);

    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === id);
    res.json({ success: true, data: persona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── PUT /api/personas/:id/total  →  incrementar / decrementar ──────────────
router.put('/:id/total', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { accion, razon } = req.body;
    const conn = getPool();

    if (!['incrementar', 'decrementar'].includes(accion)) {
      return res.status(400).json({ success: false, data: null, error: 'accion debe ser "incrementar" o "decrementar"' });
    }

    const [check] = await conn.execute('SELECT id FROM personas WHERE id = ?', [id]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }

    const op = accion === 'incrementar' ? '+' : '-';
    await conn.execute(
      `UPDATE ranking SET total_votos = GREATEST(total_votos ${op} 1, 0) WHERE persona_id = ?`,
      [id]
    );

    if (razon) {
      await conn.execute(
        'INSERT INTO razones (persona_id, descripcion) VALUES (?, ?)',
        [id, razon]
      );
    }

    await updateMedals(conn);

    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === id);
    res.json({ success: true, data: persona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── DELETE /api/personas/:id  →  eliminar (requiere password) ──────────────
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body;
    const conn = getPool();

    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (password !== adminPass) {
      return res.status(403).json({ success: false, data: null, error: 'Contraseña incorrecta' });
    }

    // Obtener datos antes de eliminar
    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === id);
    if (!persona) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }

    // Eliminar en orden: razones → ranking → personas
    await conn.execute('DELETE FROM razones WHERE persona_id = ?', [id]);
    await conn.execute('DELETE FROM ranking WHERE persona_id = ?', [id]);
    await conn.execute('DELETE FROM personas WHERE id = ?', [id]);

    await updateMedals(conn);

    res.json({ success: true, data: { deleted: persona } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── Helper: actualizar medallas (top 3) ────────────────────────────────────
async function updateMedals(conn) {
  await conn.execute("UPDATE ranking SET medalla = ''");
  const [top] = await conn.execute(
    'SELECT id FROM ranking ORDER BY total_votos DESC LIMIT 3'
  );
  const medals = ['gold', 'silver', 'bronze'];
  for (let i = 0; i < top.length && i < 3; i++) {
    await conn.execute('UPDATE ranking SET medalla = ? WHERE id = ?', [medals[i], top[i].id]);
  }
}

module.exports = router;
