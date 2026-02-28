const express = require('express');
const { getPool } = require('../lib/db');

const router = express.Router();

// ─── Helper: leaderboard (solo razones aprobadas) ───────────────────────────
async function buildLeaderboard(conn) {
  const [rows] = await conn.execute(
    `SELECT
       p.id,
       p.nombre,
       p.carrera,
       p.genero,
       r.total_votos AS total,
       r.medalla     AS medal,
       GROUP_CONCAT(
         CASE WHEN ra.status = 'aprobado' THEN ra.descripcion END
         ORDER BY ra.id ASC
         SEPARATOR ', '
       ) AS razon
     FROM ranking r
     JOIN personas p  ON r.persona_id = p.id
     LEFT JOIN razones ra ON ra.persona_id = p.id
     GROUP BY p.id, p.nombre, p.carrera, p.genero, r.total_votos, r.medalla
     ORDER BY r.total_votos DESC, p.nombre ASC`
  );

  return rows.map((row, i) => ({
    pos: i + 1,
    id: row.id,
    nombre: row.nombre,
    carrera: row.carrera,
    genero: row.genero || 'desconocido',
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

// ─── GET /api/personas/moderacion/pendientes  →  panel de moderación ────────
router.get('/moderacion/pendientes', async (_req, res) => {
  try {
    const conn = getPool();
    const [rows] = await conn.execute(
      `SELECT
         rz.id AS razon_id,
         rz.descripcion,
         rz.status,
         rz.created_at,
         p.id AS persona_id,
         p.nombre AS persona_nombre,
         p.carrera AS persona_carrera,
         p.genero AS persona_genero,
         r.total_votos,
         r.posicion
       FROM razones rz
       JOIN personas p ON rz.persona_id = p.id
       LEFT JOIN ranking r ON r.persona_id = p.id
       ORDER BY FIELD(rz.status, 'pendiente', 'rechazado', 'aprobado'), rz.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── PUT /api/personas/moderacion/:razonId  →  aprobar / rechazar ───────────
router.put('/moderacion/:razonId', async (req, res) => {
  try {
    const razonId = parseInt(req.params.razonId, 10);
    const { status } = req.body;
    const conn = getPool();

    if (!['pendiente', 'aprobado', 'rechazado'].includes(status)) {
      return res.status(400).json({ success: false, data: null, error: 'status debe ser "pendiente", "aprobado" o "rechazado"' });
    }

    const [check] = await conn.execute('SELECT id FROM razones WHERE id = ?', [razonId]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Razón no encontrada' });
    }

    await conn.execute('UPDATE razones SET status = ? WHERE id = ?', [status, razonId]);

    res.json({ success: true, data: { razon_id: razonId, status } });
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
    const { nombre, carrera, genero, razon } = req.body;
    if (!nombre || !carrera) {
      return res.status(400).json({ success: false, data: null, error: 'nombre y carrera son requeridos' });
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
      // Agregar razón si se proporcionó (status: pendiente por defecto)
      if (razon) {
        await conn.execute(
          'INSERT INTO razones (persona_id, descripcion) VALUES (?, ?)',
          [personaId, razon]
        );
      }
    } else {
      // Crear nueva persona
      const gen = genero || 'desconocido';
      const [insertP] = await conn.execute(
        'INSERT INTO personas (nombre, carrera, genero) VALUES (?, ?, ?)',
        [nombre, carrera, gen]
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

    await updateMedals(conn);

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
    const { nombre, carrera, genero, total, razon } = req.body;
    const conn = getPool();

    const [check] = await conn.execute('SELECT id FROM personas WHERE id = ?', [id]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }

    const updates = [];
    const values = [];
    if (nombre !== undefined)  { updates.push('nombre = ?');  values.push(nombre); }
    if (carrera !== undefined)  { updates.push('carrera = ?');  values.push(carrera); }
    if (genero !== undefined)  { updates.push('genero = ?');  values.push(genero); }

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

    const leaderboard = await buildLeaderboard(conn);
    const persona = leaderboard.find(r => r.id === id);
    if (!persona) {
      return res.status(404).json({ success: false, data: null, error: 'Persona no encontrada' });
    }

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
