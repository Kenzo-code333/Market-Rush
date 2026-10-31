# Market Rush 🚀📈

A real-time multiplayer trading game set on a space-colony market. 2–6 traders,
5 commodities, 5 minutes. Every trade moves the price for everyone. Richest
trader at the closing bell wins.

```bash
pip install -r requirements.txt
python run.py
```

Then open **http://localhost:8000**, create a room and share the link.
To play alone on one computer, open the link in several browser tabs. Each tab is a separate trader.

See [CLAUDE.md](CLAUDE.md) for the architecture, full rules and how to tweak balance
(`server/config.py`).
