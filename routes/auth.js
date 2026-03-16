const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../database');
const { JWT_SECRET } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await query('UPDATE users SET force_logout = FALSE WHERE id = $1', [user.id]);

    const token = jwt.sign(
      { id: user.id, name: user.name, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
