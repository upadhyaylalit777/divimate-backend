const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// ---------------------- ROUTES ---------------------- //

// ✅ Create a new user
app.post('/users', async (req, res) => {
  try {
    const { name, email } = req.body;
        const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    
    const user = await prisma.user.create({
      data: { name, email },
    });
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

// ✅ Get all users
app.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ✅ Create a group and assign members
app.post('/groups/:groupId/expenses', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { description, amount, paidById } = req.body;

    const expense = await prisma.expense.create({
      data: {
        description,
        amount: parseFloat(amount),
        paidById,
        groupId,
      },
    });

    res.json(expense);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});


// ✅ Run the server
app.listen(4000, () => {
  console.log('Server running on http://localhost:4000');
});

app.post('/groups', async (req, res) => {
  try {
    const { name, userIds } = req.body;

    const group = await prisma.group.create({
      data: {
        name,
        members: {
          create: userIds.map(userId => ({
            user: { connect: { id: userId } },
          })),
        },
      },
      include: {
        members: { include: { user: true } },
      },
    });

    res.json(group);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});


// ✅ Get all groups with their members
app.get('/groups', async (req, res) => {
  try {
    const groups = await prisma.group.findMany({
      include: {
        members: {
          include: {
            user: true,
          },
        },
      },
    });

    // Optional: clean up response to show only user data
    const formatted = groups.map(group => ({
      id: group.id,
      name: group.name,
      members: group.members.map(m => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
      })),
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// ✅ Get summary of balances in a group
app.get('/groups/:groupId/summary', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);

    // Fetch group with users and expenses
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: { include: { user: true } },
        expenses: true,
      },
    });

    if (!group) return res.status(404).json({ error: 'Group not found' });

    const users = group.members.map((m) => m.user);
    const userIds = users.map((u) => u.id);
    const totalExpense = group.expenses.reduce((sum, e) => sum + e.amount, 0);
    const splitAmount = totalExpense / users.length;

    const paidMap = {};
    const balances = [];

    users.forEach((u) => (paidMap[u.id] = 0));
    group.expenses.forEach((e) => {
      paidMap[e.paidById] += e.amount;
    });

    users.forEach((u) => {
      const balance = +(paidMap[u.id] - splitAmount).toFixed(2);
      balances.push({
        id: u.id,
        name: u.name,
        email: u.email,
        paid: paidMap[u.id],
        owes: splitAmount,
        balance,
      });
    });

    // 🔁 Compute transactions
    const debtors = balances.filter(b => b.balance < 0).sort((a, b) => a.balance - b.balance);
    const creditors = balances.filter(b => b.balance > 0).sort((a, b) => b.balance - a.balance);
    const transactions = [];

    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i];
      const creditor = creditors[j];

      const amount = Math.min(Math.abs(debtor.balance), creditor.balance);
      if (amount > 0.01) {
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

    res.json({
      group: group.name,
      totalExpense,
      splitPerHead: +splitAmount.toFixed(2),
      members: balances,
      transactions
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});


