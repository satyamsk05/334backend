export function getAdminDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>334GAME - SuperAdmin Control Panel</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', sans-serif; }
        body { background-color: #120924; color: #FFFFFF; min-height: 100vh; padding: 20px; }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid #2A1A45; margin-bottom: 24px; }
        .header h1 { font-size: 24px; color: #FFD700; font-weight: 700; }
        .header .status-badge { background: #1E3A29; color: #4ADE80; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 14px; }
        
        .login-box { max-width: 400px; margin: 80px auto; background: #1D1236; border: 1px solid #33205B; padding: 32px; border-radius: 16px; text-align: center; }
        .login-box h2 { margin-bottom: 16px; color: #FFD700; }
        .login-box input { width: 100%; padding: 12px; margin-bottom: 16px; border-radius: 8px; border: 1px solid #3B2968; background: #120924; color: #FFF; font-size: 16px; text-align: center; }
        .login-box button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #FFD700; color: #000; font-weight: 700; font-size: 16px; cursor: pointer; }
        
        .dashboard-content { display: none; }
        .grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .card { background: #1D1236; border: 1px solid #2F1E52; border-radius: 14px; padding: 20px; }
        .card .title { color: #A098B2; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
        .card .value { font-size: 26px; font-weight: 700; color: #FFF; }
        .card .value.gold { color: #FFD700; }
        .card .value.green { color: #4ADE80; }
        .card .value.red { color: #F87171; }
        
        .section-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; color: #FFD700; display: flex; justify-content: space-between; align-items: center; }
        .table-container { background: #1D1236; border: 1px solid #2F1E52; border-radius: 14px; padding: 16px; margin-bottom: 24px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th, td { padding: 12px; border-bottom: 1px solid #2A1A45; font-size: 14px; }
        th { color: #A098B2; font-weight: 600; }
        .badge-success { background: #1E3A29; color: #4ADE80; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; }
        .badge-pending { background: #3B2700; color: #FBBF24; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; }
        .badge-danger { background: #3B1212; color: #F87171; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; }
        
        .btn-action { border: none; padding: 6px 12px; border-radius: 6px; font-weight: 700; font-size: 12px; cursor: pointer; margin-right: 6px; }
        .btn-approve { background: #10B981; color: #FFF; }
        .btn-reject { background: #EF4444; color: #FFF; }
        .btn-refresh { background: #3B2968; color: #FFF; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .utr-tag { font-family: monospace; font-size: 13px; font-weight: 700; color: #DDD6FE; background: #2A1647; padding: 4px 8px; border-radius: 6px; }
    </style>
</head>
<body>

    <div id="loginSection" class="login-box">
        <h2>👑 Admin Login</h2>
        <p style="color: #A098B2; font-size: 13px; margin-bottom: 20px;">Enter Admin Secret Key to access dashboard</p>
        <input type="password" id="secretInput" placeholder="Enter Admin Secret" autocomplete="current-password">
        <button onclick="attemptLogin()">LOGIN TO DASHBOARD</button>
        <p id="errorMsg" style="color: #FF4D4D; font-size: 13px; margin-top: 12px; display: none;"></p>
    </div>

    <div id="dashboardSection" class="dashboard-content">
        <div class="header">
            <div>
                <h1>👑 334GAME SuperAdmin Panel</h1>
                <p style="color: #A098B2; font-size: 13px;">Authoritative Financial & Control Engine</p>
            </div>
            <div>
                <span class="status-badge">● LIVE SERVER ONLINE</span>
                <button class="btn-refresh" onclick="fetchDashboardData()" style="margin-left: 10px;">↻ Refresh</button>
            </div>
        </div>

        <div class="grid-cards">
            <div class="card">
                <div class="title">PENDING DEPOSITS</div>
                <div class="value gold" id="pendingDepCount">0</div>
            </div>
            <div class="card">
                <div class="title">PENDING WITHDRAWALS</div>
                <div class="value red" id="pendingWdCount">0</div>
            </div>
            <div class="card">
                <div class="title">ACTIVE PLAYERS</div>
                <div class="value green" id="activePlayers">1 Live 🟢</div>
            </div>
            <div class="card">
                <div class="title">NET HOUSE PROFIT</div>
                <div class="value gold" id="houseProfit">₹18,450.00</div>
            </div>
        </div>

        <!-- 1. PENDING DEPOSITS QUEUE -->
        <div class="section-title">
            <span>📥 Pending Deposits Queue (UTR Review)</span>
            <span class="badge-pending" id="depQueueBadge">0 Pending</span>
        </div>
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Order ID</th>
                        <th>User ID</th>
                        <th>Amount (₹)</th>
                        <th>Submitted UTR</th>
                        <th>Date & Time</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="depositsTableBody">
                    <tr><td colspan="7" style="text-align: center; color: #9CA3AF;">No pending deposits</td></tr>
                </tbody>
            </table>
        </div>

        <!-- 2. PENDING WITHDRAWALS QUEUE -->
        <div class="section-title">
            <span>💸 Pending Withdrawals Queue (Payout Review)</span>
            <span class="badge-pending" id="wdQueueBadge">0 Pending</span>
        </div>
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Withdrawal ID</th>
                        <th>User ID</th>
                        <th>Amount (₹)</th>
                        <th>UPI ID</th>
                        <th>Date & Time</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="withdrawalsTableBody">
                    <tr><td colspan="7" style="text-align: center; color: #9CA3AF;">No pending withdrawals</td></tr>
                </tbody>
            </table>
        </div>

        <!-- 3. USER BALANCES -->
        <div class="section-title">👥 Registered Users & Live Balances</div>
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>User ID</th>
                        <th>Name</th>
                        <th>Deposit Balance</th>
                        <th>Winning Balance</th>
                        <th>Bonus Balance</th>
                        <th>Total Balance</th>
                    </tr>
                </thead>
                <tbody id="userTableBody">
                    <tr>
                        <td>USR-304</td>
                        <td>Satyam Kumar</td>
                        <td>₹500.00</td>
                        <td>₹1,250.00</td>
                        <td>₹100.00</td>
                        <td style="color: #FFD700; font-weight: 700;">₹1,850.00</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <script>
        let adminSecret = localStorage.getItem('adminSecret') || '';

        function attemptLogin() {
            const inputVal = document.getElementById('secretInput').value.trim();
            if (!inputVal) return;
            adminSecret = inputVal;
            localStorage.setItem('adminSecret', adminSecret);
            fetchDashboardData();
        }

        async function fetchDashboardData() {
            try {
                // Fetch Analytics
                const res = await fetch('/api/v1/admin/analytics?secret=' + encodeURIComponent(adminSecret));
                const data = await res.json();
                if (data.success) {
                    document.getElementById('loginSection').style.display = 'none';
                    document.getElementById('dashboardSection').style.display = 'block';
                    
                    document.getElementById('activePlayers').innerText = (data.data.totalActivePlayers || 1) + ' Live 🟢';
                    document.getElementById('houseProfit').innerText = '₹' + (data.data.netHouseProfitRupees || 18450).toFixed(2);
                } else {
                    document.getElementById('errorMsg').innerText = 'Invalid Admin Secret Key!';
                    document.getElementById('errorMsg').style.display = 'block';
                    return;
                }

                // Fetch Pending Deposits
                const depRes = await fetch('/api/v1/admin/deposits/pending?secret=' + encodeURIComponent(adminSecret));
                const depData = await depRes.json();
                if (depData.success) {
                    renderDepositsTable(depData.data || []);
                }

                // Fetch Pending Withdrawals
                const wdRes = await fetch('/api/v1/admin/withdrawals/pending?secret=' + encodeURIComponent(adminSecret));
                const wdData = await wdRes.json();
                if (wdData.success) {
                    renderWithdrawalsTable(wdData.data || []);
                }
            } catch (e) {
                console.error(e);
            }
        }

        function renderDepositsTable(deposits) {
            const tbody = document.getElementById('depositsTableBody');
            document.getElementById('pendingDepCount').innerText = deposits.length;
            document.getElementById('depQueueBadge').innerText = deposits.length + ' Pending';

            if (deposits.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #9CA3AF;">No pending deposits</td></tr>';
                return;
            }

            tbody.innerHTML = deposits.map(d => \`
                <tr>
                    <td style="font-family: monospace;">\${d.depositId}</td>
                    <td>\${d.userId}</td>
                    <td style="color: #4ADE80; font-weight: 700;">₹\${d.amountRupees.toFixed(2)}</td>
                    <td><span class="utr-tag">\${d.utr || 'Not Submitted'}</span></td>
                    <td>\${new Date(d.createdAt).toLocaleString()}</td>
                    <td><span class="badge-pending">\${d.status}</span></td>
                    <td>
                        <button class="btn-action btn-approve" onclick="handleDepositAction('\${d.depositId}', 'APPROVE')">✓ APPROVE</button>
                        <button class="btn-action btn-reject" onclick="handleDepositAction('\${d.depositId}', 'REJECT')">✕ REJECT</button>
                    </td>
                </tr>
            \`).join('');
        }

        function renderWithdrawalsTable(withdrawals) {
            const tbody = document.getElementById('withdrawalsTableBody');
            document.getElementById('pendingWdCount').innerText = withdrawals.length;
            document.getElementById('wdQueueBadge').innerText = withdrawals.length + ' Pending';

            if (withdrawals.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #9CA3AF;">No pending withdrawals</td></tr>';
                return;
            }

            tbody.innerHTML = withdrawals.map(w => \`
                <tr>
                    <td style="font-family: monospace;">\${w.withdrawalId}</td>
                    <td>\${w.userId}</td>
                    <td style="color: #F87171; font-weight: 700;">₹\${w.amountRupees.toFixed(2)}</td>
                    <td style="font-family: monospace; color: #DDD6FE;">\${w.upiId}</td>
                    <td>\${new Date(w.createdAt).toLocaleString()}</td>
                    <td><span class="badge-pending">\${w.status}</span></td>
                    <td>
                        <button class="btn-action btn-approve" onclick="handleWithdrawalAction('\${w.withdrawalId}', 'APPROVE')">✓ APPROVE</button>
                        <button class="btn-action btn-reject" onclick="handleWithdrawalAction('\${w.withdrawalId}', 'REJECT')">✕ REJECT</button>
                    </td>
                </tr>
            \`).join('');
        }

        async function handleDepositAction(depositId, action) {
            if (!confirm('Are you sure you want to ' + action + ' deposit ' + depositId + '?')) return;
            try {
                const res = await fetch('/api/v1/admin/deposits/action?secret=' + encodeURIComponent(adminSecret), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ depositId, action })
                });
                const data = await res.json();
                alert(data.message);
                fetchDashboardData();
            } catch (e) {
                alert('Action failed');
            }
        }

        async function handleWithdrawalAction(withdrawalId, action) {
            if (!confirm('Are you sure you want to ' + action + ' withdrawal ' + withdrawalId + '?')) return;
            try {
                const res = await fetch('/api/v1/admin/withdrawals/action?secret=' + encodeURIComponent(adminSecret), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ withdrawalId, action })
                });
                const data = await res.json();
                alert(data.message);
                fetchDashboardData();
            } catch (e) {
                alert('Action failed');
            }
        }

        // Auto load if secret exists
        if (adminSecret) {
            fetchDashboardData();
        }

        // Auto refresh stats every 3s
        setInterval(() => {
            if (document.getElementById('dashboardSection').style.display === 'block') {
                fetchDashboardData();
            }
        }, 3000);
    </script>
</body>
</html>`;
}
