const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key';

// ---------------------- AUTH ROUTES ---------------------- //

app.post('/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, password: hashedPassword } });
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = jwt.sign({ sub: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ---------------------- GROUP ROUTES ---------------------- //

app.post('/groups', async (req, res) => {
  try {
    const { name, userIds } = req.body;
    const group = await prisma.group.create({
      data: {
        name,
        members: { create: userIds.map(userId => ({ user: { connect: { id: userId } } })) },
      },
      include: { members: { include: { user: true } }, expenses: true },
    });
    res.json(group);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/groups/:groupId/add-member', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }
    const group = await prisma.group.update({
      where: { id: groupId },
      data: {
        members: { create: { user: { connect: { id: userId } } } },
      },
      include: { members: { include: { user: true } }, expenses: true },
    });
    res.json(group);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/groups/:groupId/expenses', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { description, amount, paidById } = req.body;
    const expense = await prisma.expense.create({
      data: { description, amount: parseFloat(amount), paidById, groupId },
    });
    res.json(expense);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

app.get('/groups', async (req, res) => {
  try {
    const { userId } = req.query;
    let groups = [];

    if (userId) {
      groups = await prisma.group.findMany({
        where: { members: { some: { userId: parseInt(userId) } } },
        include: { members: { include: { user: true } }, expenses: true },
      });
    } else {
      groups = await prisma.group.findMany({
        include: { members: { include: { user: true } }, expenses: true },
      });
    }

    const formatted = groups.map(group => ({
      id: group.id,
      name: group.name,
      members: group.members.map(m => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email
      })),
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.get('/groups/:groupId/summary', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { include: { user: true } }, expenses: true },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const users = group.members.map(m => m.user);
    const totalExpense = group.expenses.reduce((sum, e) => sum + e.amount, 0);
    const splitAmount = +(totalExpense / users.length).toFixed(2);
    const paidMap = {};
    users.forEach(u => (paidMap[u.id] = 0));
    group.expenses.forEach(e => (paidMap[e.paidById] += e.amount));
    const balances = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      paid: +paidMap[u.id].toFixed(2),
      owes: +splitAmount.toFixed(2),
      balance: +((paidMap[u.id] - splitAmount).toFixed(2)),
    }));
    const debtors = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance);
    const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance);
    const transactions = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i];
      const creditor = creditors[j];
      const amount = Math.min(Math.abs(debtor.balance), creditor.balance);
      if (amount > 0.01) {
        transactions.push({ from: debtor.name, to: creditor.name, amount: +amount.toFixed(2) });
        debtor.balance += amount;
        creditor.balance -= amount;
      }
      if (Math.abs(debtor.balance) < 0.01) i++;
      if (Math.abs(creditor.balance) < 0.01) j++;
    }
    res.json({
      group: group.name,
      totalExpense,
      splitPerHead: +splitAmount.toFixed(2),
      members: balances,
      transactions,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});

app.listen(4000, () => {
  console.log('Server running on http://localhost:4000');
});
