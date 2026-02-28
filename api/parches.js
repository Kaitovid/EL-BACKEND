const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../lib/db');

const router = express.Router();

// ─── Helper: generar fingerprint a partir de IP + User-Agent ────────────────
function getFingerprint(req) {
  const raw = (req.ip || '') + (req.headers['user-agent'] || '');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─── Helper: hash de IP para anti-spam ──────────────────────────────────────
function hashIP(req) {
  return crypto.createHash('sha256').update(req.ip || '').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS PÚBLICOS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/parches  →  parches aprobados (tablón público) ────────────────
router.get('/', async (_req, res) => {
  try {
    const conn = getPool();
    const [rows] = await conn.execute(
      `SELECT
         p.id,
         p.autor,
         p.carrera,
         p.titulo,
         p.descripcion,
         p.categoria,
         p.emoji,
         p.lugar,
         p.fecha,
         p.hora,
         p.cupo,
         p.requisitos,
         p.contacto,
         p.created_at,
         COUNT(pi.id) AS total_interesados,
         IF(p.cupo IS NOT NULL, GREATEST(p.cupo - COUNT(pi.id), 0), NULL) AS cupos_restantes
       FROM parches p
       LEFT JOIN parches_interesados pi ON pi.parche_id = p.id
       WHERE p.status = 'aprobado'
       GROUP BY p.id
       ORDER BY
         CASE WHEN p.fecha >= CURDATE() THEN 0 ELSE 1 END ASC,
         p.fecha ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── GET /api/parches/:id  →  detalle de un parche aprobado ─────────────────
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const conn = getPool();
    const [rows] = await conn.execute(
      `SELECT
         p.id,
         p.autor,
         p.carrera,
         p.titulo,
         p.descripcion,
         p.categoria,
         p.emoji,
         p.lugar,
         p.fecha,
         p.hora,
         p.cupo,
         p.requisitos,
         p.contacto,
         p.created_at,
         COUNT(pi.id) AS total_interesados,
         IF(p.cupo IS NOT NULL, GREATEST(p.cupo - COUNT(pi.id), 0), NULL) AS cupos_restantes
       FROM parches p
       LEFT JOIN parches_interesados pi ON pi.parche_id = p.id
       WHERE p.id = ? AND p.status = 'aprobado'
       GROUP BY p.id`,
      [id]
    );

    if (rows.length === 0 || !rows[0].id) {
      return res.status(404).json({ success: false, data: null, error: 'Parche no encontrado' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── POST /api/parches  →  publicar un parche (queda pendiente) ─────────────
router.post('/', async (req, res) => {
  try {
    const {
      autor, carrera, titulo, descripcion, categoria,
      emoji, lugar, fecha, hora, cupo, requisitos, contacto
    } = req.body;

    if (!autor || !titulo || !descripcion || !lugar || !fecha || !hora) {
      return res.status(400).json({
        success: false, data: null,
        error: 'autor, titulo, descripcion, lugar, fecha y hora son requeridos'
      });
    }

    const conn = getPool();
    const ipHash = hashIP(req);

    const [result] = await conn.execute(
      `INSERT INTO parches
        (autor, carrera, titulo, descripcion, categoria, emoji, lugar, fecha, hora, cupo, requisitos, contacto, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        autor,
        carrera || null,
        titulo,
        descripcion,
        categoria || 'parche',
        emoji || '🫂',
        lugar,
        fecha,
        hora,
        cupo || null,
        requisitos || null,
        contacto || null,
        ipHash
      ]
    );

    const [inserted] = await conn.execute('SELECT * FROM parches WHERE id = ?', [result.insertId]);

    res.status(201).json({ success: true, data: inserted[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── POST /api/parches/:id/interesado  →  toggle "Me interesa" ──────────────
router.post('/:id/interesado', async (req, res) => {
  try {
    const parcheId = parseInt(req.params.id, 10);
    const conn = getPool();
    const fingerprint = getFingerprint(req);

    // Verificar que el parche existe y está aprobado
    const [check] = await conn.execute(
      'SELECT id FROM parches WHERE id = ? AND status = ?',
      [parcheId, 'aprobado']
    );
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Parche no encontrado' });
    }

    // Verificar si ya marcó interés
    const [existing] = await conn.execute(
      'SELECT id FROM parches_interesados WHERE parche_id = ? AND fingerprint = ?',
      [parcheId, fingerprint]
    );

    let accion;
    if (existing.length > 0) {
      await conn.execute(
        'DELETE FROM parches_interesados WHERE parche_id = ? AND fingerprint = ?',
        [parcheId, fingerprint]
      );
      accion = 'removed';
    } else {
      await conn.execute(
        'INSERT INTO parches_interesados (parche_id, fingerprint) VALUES (?, ?)',
        [parcheId, fingerprint]
      );
      accion = 'added';
    }

    const [countRows] = await conn.execute(
      'SELECT COUNT(*) AS total FROM parches_interesados WHERE parche_id = ?',
      [parcheId]
    );

    res.json({
      success: true,
      data: { accion, total_interesados: countRows[0].total }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS DE MODERACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/parches/auth/login  →  autenticar moderador ──────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, data: null, error: 'token es requerido' });
    }

    const conn = getPool();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [rows] = await conn.execute(
      'SELECT id, alias, rol FROM moderadores WHERE token_hash = ? AND activo = 1 LIMIT 1',
      [tokenHash]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, data: null, error: 'Token inválido' });
    }

    // Registrar login
    await conn.execute('UPDATE moderadores SET last_login = NOW() WHERE id = ?', [rows[0].id]);

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── GET /api/parches/moderacion/todos  →  panel de moderación ──────────────
router.get('/moderacion/todos', async (_req, res) => {
  try {
    const conn = getPool();
    const [rows] = await conn.execute(
      `SELECT
         p.id AS parche_id,
         p.titulo,
         p.descripcion,
         p.categoria,
         p.emoji,
         p.autor,
         p.carrera,
         p.lugar,
         p.fecha,
         p.hora,
         p.cupo,
         p.requisitos,
         p.contacto,
         p.status,
         p.mod_nota,
         p.mod_at,
         p.created_at,
         m.alias AS mod_alias,
         COUNT(pi.id) AS total_interesados
       FROM parches p
       LEFT JOIN moderadores m ON m.id = p.mod_id
       LEFT JOIN parches_interesados pi ON pi.parche_id = p.id
       GROUP BY p.id, m.alias
       ORDER BY FIELD(p.status, 'pendiente', 'rechazado', 'aprobado'), p.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── PUT /api/parches/moderacion/:id  →  aprobar / rechazar parche ──────────
router.put('/moderacion/:id', async (req, res) => {
  try {
    const parcheId = parseInt(req.params.id, 10);
    const { status, mod_id, mod_nota } = req.body;
    const conn = getPool();

    if (!['pendiente', 'aprobado', 'rechazado'].includes(status)) {
      return res.status(400).json({
        success: false, data: null,
        error: 'status debe ser "pendiente", "aprobado" o "rechazado"'
      });
    }

    const [check] = await conn.execute('SELECT id FROM parches WHERE id = ?', [parcheId]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Parche no encontrado' });
    }

    await conn.execute(
      'UPDATE parches SET status = ?, mod_id = ?, mod_nota = ?, mod_at = NOW() WHERE id = ?',
      [status, mod_id || null, mod_nota || null, parcheId]
    );

    const [updated] = await conn.execute('SELECT * FROM parches WHERE id = ?', [parcheId]);

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

// ─── DELETE /api/parches/:id  →  eliminar parche (admin) ────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const parcheId = parseInt(req.params.id, 10);
    const { token } = req.body;
    const conn = getPool();

    // Verificar que es admin
    const tokenHash = crypto.createHash('sha256').update(token || '').digest('hex');
    const [mod] = await conn.execute(
      'SELECT id, rol FROM moderadores WHERE token_hash = ? AND activo = 1',
      [tokenHash]
    );
    if (mod.length === 0 || mod[0].rol !== 'admin') {
      return res.status(403).json({ success: false, data: null, error: 'No autorizado' });
    }

    const [check] = await conn.execute('SELECT * FROM parches WHERE id = ?', [parcheId]);
    if (check.length === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Parche no encontrado' });
    }

    // CASCADE elimina interesados automáticamente
    await conn.execute('DELETE FROM parches WHERE id = ?', [parcheId]);

    res.json({ success: true, data: { deleted: check[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

module.exports = router;
