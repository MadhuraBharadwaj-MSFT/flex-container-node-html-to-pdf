function buildSampleInvoiceHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sample invoice</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef2f7;
      color: #172033;
      font-family: "Noto Sans", "Liberation Sans", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .page {
      min-height: 297mm;
      padding: 18mm;
      background: #ffffff;
    }
    .top-bar {
      height: 8px;
      margin: -18mm -18mm 15mm;
      background: linear-gradient(90deg, #2563eb, #0ea5e9);
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 32px;
      margin-bottom: 34px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .mark {
      display: grid;
      width: 44px;
      height: 44px;
      place-items: center;
      border-radius: 12px;
      background: #2563eb;
      color: #ffffff;
      font-size: 20px;
      font-weight: 800;
    }
    .brand h1, .brand p, .invoice-title h2, .invoice-title p {
      margin: 0;
    }
    .brand h1 { font-size: 20px; letter-spacing: -0.02em; }
    .muted { color: #64748b; }
    .invoice-title { text-align: right; }
    .invoice-title h2 {
      color: #2563eb;
      font-size: 32px;
      letter-spacing: 0.08em;
    }
    .details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
      margin-bottom: 34px;
    }
    .card {
      padding: 18px;
      border: 1px solid #dbe3ee;
      border-radius: 12px;
      background: #f8fafc;
    }
    .card h3 {
      margin: 0 0 9px;
      color: #475569;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      padding: 4px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 12px;
    }
    thead { background: #172033; color: #ffffff; }
    th, td { padding: 13px 14px; text-align: left; }
    th {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    tbody tr { border-bottom: 1px solid #e2e8f0; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    .number { text-align: right; white-space: nowrap; }
    .summary {
      display: grid;
      grid-template-columns: 1fr 260px;
      gap: 36px;
      margin-top: 26px;
    }
    .note {
      padding: 16px;
      border-left: 4px solid #0ea5e9;
      background: #f0f9ff;
      color: #334155;
    }
    .totals { width: 100%; }
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 7px 0;
    }
    .grand-total {
      margin-top: 7px;
      padding-top: 12px;
      border-top: 2px solid #172033;
      color: #2563eb;
      font-size: 18px;
      font-weight: 800;
    }
    footer {
      display: flex;
      justify-content: space-between;
      margin-top: 54px;
      padding-top: 16px;
      border-top: 1px solid #dbe3ee;
      color: #64748b;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <main class="page">
    <div class="top-bar"></div>
    <header>
      <div class="brand">
        <div class="mark">AC</div>
        <div>
          <h1>Alpine Cloud Studio</h1>
          <p class="muted">Design systems for ambitious teams</p>
        </div>
      </div>
      <div class="invoice-title">
        <h2>INVOICE</h2>
        <p class="muted">#DEMO-2026-001</p>
      </div>
    </header>

    <section class="details">
      <div class="card">
        <h3>Bill to</h3>
        <strong>Contoso Outdoor Supply</strong><br>
        Accounts Payable<br>
        100 Market Street<br>
        Seattle, WA 98101
      </div>
      <div class="card">
        <h3>Invoice details</h3>
        <div class="meta-row"><span class="muted">Issued</span><strong>November 8, 2026</strong></div>
        <div class="meta-row"><span class="muted">Due</span><strong>December 8, 2026</strong></div>
        <div class="meta-row"><span class="muted">Terms</span><strong>Net 30</strong></div>
      </div>
    </section>

    <table aria-label="Invoice line items">
      <thead>
        <tr>
          <th>Description</th>
          <th class="number">Quantity</th>
          <th class="number">Rate</th>
          <th class="number">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Product design sprint</strong><br><span class="muted">Research, workshop, and prototype</span></td>
          <td class="number">1</td>
          <td class="number">$4,800.00</td>
          <td class="number">$4,800.00</td>
        </tr>
        <tr>
          <td><strong>Design system implementation</strong><br><span class="muted">Core components and documentation</span></td>
          <td class="number">40</td>
          <td class="number">$145.00</td>
          <td class="number">$5,800.00</td>
        </tr>
        <tr>
          <td><strong>Accessibility review</strong><br><span class="muted">WCAG review and remediation notes</span></td>
          <td class="number">8</td>
          <td class="number">$165.00</td>
          <td class="number">$1,320.00</td>
        </tr>
      </tbody>
    </table>

    <section class="summary">
      <div class="note">
        Thank you for your business. This invoice is generated from self-contained
        HTML by the Azure Functions BYOC sample.
      </div>
      <div class="totals">
        <div class="total-row"><span class="muted">Subtotal</span><strong>$11,920.00</strong></div>
        <div class="total-row"><span class="muted">Tax (8.5%)</span><strong>$1,013.20</strong></div>
        <div class="total-row grand-total"><span>Total</span><span>$12,933.20</span></div>
      </div>
    </section>

    <footer>
      <span>alpine.example</span>
      <span>billing@alpine.example</span>
      <span>+1 (555) 010-2026</span>
    </footer>
  </main>
</body>
</html>`;
}

module.exports = {
  buildSampleInvoiceHtml,
};
