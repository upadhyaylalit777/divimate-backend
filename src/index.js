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
const PORT = process.env.PORT || 4000;

// ---------------------- HEALTH CHECK ---------------------- //

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Debug route to check if updated code is deployed
app.get('/api/debug', async (req, res) => {
  try {
    // Debug environment variables
    const dbUrl = process.env.DATABASE_URL;
    console.log('DATABASE_URL:', dbUrl ? `${dbUrl.substring(0, 20)}...` : 'undefined');
    
    await prisma.$connect();
    res.json({ 
      database: 'connected', 
      timestamp: new Date().toISOString(),
      routes: 'loaded',
      dbUrlPrefix: dbUrl ? dbUrl.substring(0, 10) : 'undefined'
    });
  } catch (error) {
    res.status(500).json({ 
      database: 'failed', 
      error: error.message,
      timestamp: new Date().toISOString(),
      dbUrlPrefix: process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 10) : 'undefined',
      allEnvVars: Object.keys(process.env).filter(key => key.includes('DATABASE'))
    });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Divimate Backend API', status: 'running' });
});

// ---------------------- AUTH ROUTES ---------------------- //

app.post('/api/users', async (req, res) => {
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

app.post('/api/users/login', async (req, res) => {
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

app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ---------------------- GROUP ROUTES ---------------------- //

app.post('/api/groups', async (req, res) => {
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

app.post('/api/groups/:groupId/add-member', async (req, res) => {
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

app.post('/api/groups/:groupId/expenses', async (req, res) => {
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

app.get('/api/groups', async (req, res) => {
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

app.get('/api/groups/:groupId/summary', async (req, res) => {
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
    
    // Calculate how much each user has paid
    const paidMap = {};
    users.forEach(u => (paidMap[u.id] = 0));
    group.expenses.forEach(e => (paidMap[e.paidById] += e.amount));
    
    // Calculate balances - FIXED: Don't round to 0 prematurely
    const balances = users.map(u => {
      const paid = paidMap[u.id];
      const owes = splitAmount;
      const balance = paid - owes; // Positive = they are owed money, Negative = they owe money
      
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        paid: +paid.toFixed(2),
        owes: +owes.toFixed(2),
        balance: +balance.toFixed(2), // Keep the actual balance, don't round to 0
      };
    });
    
    console.log('Calculated balances:', balances);
    
    // Calculate transactions to settle debts
    const debtors = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance);
    const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance);
    
    console.log('Debtors:', debtors);
    console.log('Creditors:', creditors);
    
    const transactions = [];
    let i = 0, j = 0;
    
    // Create copies to avoid modifying original data
    const debtorsCopy = debtors.map(d => ({ ...d }));
    const creditorsCopy = creditors.map(c => ({ ...c }));
    
    while (i < debtorsCopy.length && j < creditorsCopy.length) {
      const debtor = debtorsCopy[i];
      const creditor = creditorsCopy[j];
      const amount = Math.min(Math.abs(debtor.balance), creditor.balance);
      
      if (amount > 0.01) { // Only process if amount is significant
        transactions.push({ 
          from: debtor.name, 
          to: creditor.name, 
          amount: +amount.toFixed(2) 
        });
        
        debtor.balance += amount;
        creditor.balance -= amount;
      }
      
      if (Math.abs(debtor.balance) < 0.01) i++;
      if (Math.abs(creditor.balance) < 0.01) j++;
    }
    
    console.log('Generated transactions:', transactions);
    
    res.json({
      group: group.name,
      totalExpense: +totalExpense.toFixed(2),
      splitPerHead: splitAmount,
      members: balances,
      transactions,
    });
  } catch (error) {
    console.error('Error in group summary:', error);
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle 404 for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// Handle server errors
server.on('error', (err) => {
  console.error('Server error:', err);
});

module.exports = app;