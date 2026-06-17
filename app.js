/**
 * QR Check-In Pro - Main Application
 * Architecture: StorageService abstraction (Local | Firebase)
 */

/* ============================================
   STATE
   ============================================ */
const STATE = {
  customers: [],
  checkIns: [],
  currentPage: 'dashboard',
  storageMode: 'local', // 'local' | 'firebase'
  firebaseReady: false,
  unsubscribers: [],
};

/* ============================================
   LOCAL STORAGE ADAPTER
   ============================================ */
const LocalAdapter = {
  KEYS: { CUSTOMERS: 'qr_checkin_customers', CHECKINS: 'qr_checkin_history' },

  async getCustomers() {
    try { return JSON.parse(localStorage.getItem(this.KEYS.CUSTOMERS) || '[]'); } catch { return []; }
  },
  async getCheckIns() {
    try { return JSON.parse(localStorage.getItem(this.KEYS.CHECKINS) || '[]'); } catch { return []; }
  },
  async saveCustomer(customer) {
    const list = await this.getCustomers();
    const idx = list.findIndex(c => c.id === customer.id);
    if (idx >= 0) list[idx] = customer; else list.push(customer);
    localStorage.setItem(this.KEYS.CUSTOMERS, JSON.stringify(list));
  },
  async deleteCustomer(id) {
    const list = (await this.getCustomers()).filter(c => c.id !== id);
    localStorage.setItem(this.KEYS.CUSTOMERS, JSON.stringify(list));
  },
  async saveCheckIn(checkIn) {
    const list = await this.getCheckIns();
    list.push(checkIn);
    localStorage.setItem(this.KEYS.CHECKINS, JSON.stringify(list));
  },
  async clearCheckIns() {
    localStorage.setItem(this.KEYS.CHECKINS, '[]');
  },
  async clearAll() {
    localStorage.removeItem(this.KEYS.CUSTOMERS);
    localStorage.removeItem(this.KEYS.CHECKINS);
  },
  onCustomersChange(callback) {
    // localStorage doesn't support real-time; poll or use storage event
    const handler = () => this.getCustomers().then(callback);
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  },
  onCheckInsChange(callback) {
    const handler = () => this.getCheckIns().then(callback);
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  },
};

/* ============================================
   FIREBASE ADAPTER
   ============================================ */
const FirebaseAdapter = {
  db: null,

  async init() {
    // Timeout 8s để tránh đơ khi network chậm hoặc file:// chặn import
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firebase init timeout (8s). Hãy kiểm tra Firestore đã bật chưa.')), 8000)
    );

    const initPromise = (async () => {
      const { initializeApp, getApps, getApp } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
      const { getFirestore, collection, doc, setDoc, deleteDoc, addDoc,
              getDocs, onSnapshot, query, orderBy, writeBatch }
        = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

      // Tránh lỗi "Firebase App named '[DEFAULT]' already exists"
      const app = getApps().length > 0 ? getApp() : initializeApp(window.FIREBASE_CONFIG);
      this.db = getFirestore(app);
      this._collection = collection;
      this._doc = doc;
      this._setDoc = setDoc;
      this._deleteDoc = deleteDoc;
      this._addDoc = addDoc;
      this._getDocs = getDocs;
      this._onSnapshot = onSnapshot;
      this._query = query;
      this._orderBy = orderBy;
      this._writeBatch = writeBatch;
      return true;
    })();

    return Promise.race([initPromise, timeoutPromise]);
  },

  async getCustomers() {
    const snap = await this._getDocs(this._collection(this.db, 'customers'));
    return snap.docs.map(d => d.data());
  },
  async getCheckIns() {
    const snap = await this._getDocs(
      this._query(this._collection(this.db, 'checkIns'), this._orderBy('timestamp'))
    );
    return snap.docs.map(d => d.data());
  },
  async saveCustomer(customer) {
    await this._setDoc(this._doc(this.db, 'customers', customer.id), customer);
  },
  async deleteCustomer(id) {
    await this._deleteDoc(this._doc(this.db, 'customers', id));
  },
  async saveCheckIn(checkIn) {
    await this._setDoc(this._doc(this.db, 'checkIns', checkIn.id), checkIn);
  },
  async clearCheckIns() {
    const snap = await this._getDocs(this._collection(this.db, 'checkIns'));
    const batch = this._writeBatch(this.db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
  async clearAll() {
    const batch = this._writeBatch(this.db);
    const [custSnap, ciSnap] = await Promise.all([
      this._getDocs(this._collection(this.db, 'customers')),
      this._getDocs(this._collection(this.db, 'checkIns')),
    ]);
    [...custSnap.docs, ...ciSnap.docs].forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
  onCustomersChange(callback) {
    const unsub = this._onSnapshot(this._collection(this.db, 'customers'), snap => {
      callback(snap.docs.map(d => d.data()));
    });
    return unsub;
  },
  onCheckInsChange(callback) {
    const unsub = this._onSnapshot(
      this._query(this._collection(this.db, 'checkIns'), this._orderBy('timestamp')),
      snap => { callback(snap.docs.map(d => d.data())); }
    );
    return unsub;
  },
};

/* ============================================
   STORAGE SERVICE (abstraction)
   ============================================ */
const StorageService = {
  adapter: null,

  async init() {
    if (window.IS_FIREBASE_CONFIGURED) {
      // Hiện badge "đang kết nối" ở header (KHÔNG block click)
      this._setConnectingBadge(true);
      try {
        await FirebaseAdapter.init();
        this.adapter = FirebaseAdapter;
        STATE.storageMode = 'firebase';
        STATE.firebaseReady = true;
        console.log('✅ Firebase connected');
        this._setConnectingBadge(false);
        Toast.success('✅ Đã kết nối Firebase Cloud!');
      } catch (err) {
        console.warn('Firebase init failed, falling back to local:', err);
        this._setConnectingBadge(false);
        const isTimeout = err.message && err.message.includes('timeout');
        const isFileProtocol = location.protocol === 'file:';
        if (isFileProtocol) {
          Toast.warning('Firebase không hoạt động khi mở file:// — đang dùng Local mode.');
        } else if (isTimeout) {
          Toast.error('⏱ Firebase timeout. Kiểm tra Firestore đã bật chưa. Đang dùng Local mode.');
        } else {
          Toast.error('Lỗi Firebase: ' + (err.message || err).toString().slice(0, 100));
        }
        this.adapter = LocalAdapter;
        STATE.storageMode = 'local';
      }
    } else {
      this.adapter = LocalAdapter;
      STATE.storageMode = 'local';
    }

    // Load initial data
    [STATE.customers, STATE.checkIns] = await Promise.all([
      this.adapter.getCustomers(),
      this.adapter.getCheckIns(),
    ]);

    // Set up real-time listeners
    this._subscribe();

    this._updateStatusBadge();
  },

  _subscribe() {
    // Clear old listeners
    STATE.unsubscribers.forEach(fn => fn());
    STATE.unsubscribers = [];

    STATE.unsubscribers.push(
      this.adapter.onCustomersChange(customers => {
        STATE.customers = customers;
        if (STATE.currentPage === 'customers') Customers.render();
        if (STATE.currentPage === 'dashboard') Dashboard.refresh();
        SidebarStats.refresh();
      }),
      this.adapter.onCheckInsChange(checkIns => {
        STATE.checkIns = checkIns;
        if (STATE.currentPage === 'dashboard') Dashboard.refresh();
        if (STATE.currentPage === 'history') History.render();
        SidebarStats.refresh();
      })
    );
  },

  async saveCustomer(customer) { return this.adapter.saveCustomer(customer); },
  async deleteCustomer(id) { return this.adapter.deleteCustomer(id); },
  async saveCheckIn(checkIn) { return this.adapter.saveCheckIn(checkIn); },
  async clearCheckIns() {
    await this.adapter.clearCheckIns();
    STATE.checkIns = [];
    STATE.customers.forEach(c => { c.checkInCount = 0; c.lastCheckIn = null; });
    for (const c of STATE.customers) await this.adapter.saveCustomer(c);
  },
  async clearAll() {
    await this.adapter.clearAll();
    STATE.customers = [];
    STATE.checkIns = [];
  },

  _updateStatusBadge() {
    const badge = document.getElementById('storage-badge');
    if (!badge) return;
    if (STATE.storageMode === 'firebase') {
      badge.innerHTML = `<span class="badge-cloud">☁ Cloud</span>`;
      badge.title = 'Dữ liệu lưu trên Firebase (real-time)';
    } else {
      badge.innerHTML = `<span class="badge-local">⊙ Local</span>`;
      badge.title = 'Dữ liệu lưu trên máy này (localStorage)';
    }
  },

  _setConnectingBadge(connecting) {
    const badge = document.getElementById('storage-badge');
    if (!badge) return;
    if (connecting) {
      badge.innerHTML = `<span class="badge-connecting">⟳ Firebase...</span>`;
      badge.title = 'Đang kết nối Firebase...';
    } else {
      this._updateStatusBadge();
    }
  }
};

/* ============================================
   TOAST SERVICE
   ============================================ */
const Toast = {
  show(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    const icons = {
      success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
      error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `${icons[type]}<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  success: (msg) => Toast.show(msg, 'success'),
  error: (msg) => Toast.show(msg, 'error'),
  warning: (msg) => Toast.show(msg, 'warning'),
  info: (msg) => Toast.show(msg, 'info'),
};

/* ============================================
   CONFIRM MODAL SERVICE
   ============================================ */
const Confirm = {
  resolve: null,
  show(title, message) {
    return new Promise(resolve => {
      this.resolve = resolve;
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      document.getElementById('confirm-modal').classList.remove('hidden');
    });
  },
  close(result) {
    document.getElementById('confirm-modal').classList.add('hidden');
    if (this.resolve) this.resolve(result);
    this.resolve = null;
  }
};

/* ============================================
   UTILITIES
   ============================================ */
const Utils = {
  generateId() {
    if (STATE.customers.length === 0) return 'KH-001';
    const nums = STATE.customers
      .map(c => parseInt(c.id.replace(/\D/g, '')) || 0)
      .filter(n => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `KH-${String(next).padStart(3, '0')}`;
  },
  formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  },
  formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
  formatDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  },
  timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s trước`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} phút trước`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} giờ trước`;
    return Utils.formatDate(iso);
  },
  getAvatarColor(str) {
    const colors = [
      'linear-gradient(135deg, #6366f1, #8b5cf6)',
      'linear-gradient(135deg, #10b981, #059669)',
      'linear-gradient(135deg, #f59e0b, #d97706)',
      'linear-gradient(135deg, #ec4899, #be185d)',
      'linear-gradient(135deg, #3b82f6, #1d4ed8)',
      'linear-gradient(135deg, #ef4444, #b91c1c)',
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  },
  getInitials: (name) => name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
  isToday(iso) {
    const d = new Date(iso), t = new Date();
    return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
  },
  getTypeBadge(type) {
    const map = { 'VIP': 'badge-vip', 'VVIP': 'badge-vvip', 'Thường': 'badge-normal', 'Đại Lý': 'badge-agent', 'Nhân Viên': 'badge-staff' };
    return `<span class="badge ${map[type] || 'badge-normal'}">${type || 'Thường'}</span>`;
  },
  buildQRData: (c) => JSON.stringify({ id: c.id, name: c.name, phone: c.phone || '', type: c.type || 'Thường' }),
  parseQRData(raw) {
    try { return JSON.parse(raw); } catch { return { id: raw.trim() }; }
  },
  debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  }
};

/* ============================================
   NAVIGATION
   ============================================ */
const Nav = {
  init() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        this.navigate(item.dataset.page);
        if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
      });
    });
    // Bottom nav (mobile)
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
      item.addEventListener('click', () => this.navigate(item.dataset.page));
    });
    document.getElementById('menu-toggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });
    document.getElementById('main-content').addEventListener('click', () => {
      if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
    });
  },
  navigate(page) {
    if (STATE.currentPage === 'scanner' && page !== 'scanner') Scanner.stop();
    STATE.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
    document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
    const titles = { dashboard: 'Dashboard', generate: 'Tạo Mã QR', scanner: 'Quét Mã QR', customers: 'Khách Hàng', history: 'Lịch Sử Check-in', settings: 'Cài Đặt' };
    document.getElementById('header-title').textContent = titles[page] || page;
    if (page === 'dashboard') Dashboard.refresh();
    if (page === 'customers') Customers.render();
    if (page === 'history') History.render();
    if (page === 'settings') Settings.render();
  }
};

/* ============================================
   QR GENERATOR
   ============================================ */
const QRGen = {
  currentCustomer: null,

  init() {
    const form = document.getElementById('customer-form');
    form.addEventListener('submit', e => { e.preventDefault(); this.generate(); });
    document.getElementById('btn-auto-id').addEventListener('click', () => {
      document.getElementById('cust-id').value = Utils.generateId();
    });
    document.getElementById('btn-reset-form').addEventListener('click', () => { form.reset(); this.hidePreview(); });
    document.getElementById('btn-download-qr').addEventListener('click', () => this.download());
    document.getElementById('btn-print-qr').addEventListener('click', () => this.print());
    document.getElementById('cust-id').value = Utils.generateId();
  },

  async generate() {
    const name = document.getElementById('cust-name').value.trim();
    const id = document.getElementById('cust-id').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const email = document.getElementById('cust-email').value.trim();
    const type = document.getElementById('cust-type').value;
    const note = document.getElementById('cust-note').value.trim();

    if (!name || !id) { Toast.warning('Vui lòng nhập họ tên và mã khách hàng'); return; }
    if (STATE.customers.find(c => c.id.toLowerCase() === id.toLowerCase())) {
      Toast.warning(`Mã khách hàng "${id}" đã tồn tại!`); return;
    }

    const customer = { id, name, phone, email, type, note, createdAt: new Date().toISOString(), checkInCount: 0, lastCheckIn: null };

    try {
      await StorageService.saveCustomer(customer);
      if (STATE.storageMode === 'local') {
        STATE.customers.push(customer);
        SidebarStats.refresh();
        Dashboard.refresh();
      }
      this.renderQR(customer);
      this.currentCustomer = customer;
      Toast.success(`✓ Đã tạo QR cho ${name}`);
    } catch (err) {
      Toast.error('Lỗi lưu khách hàng: ' + err.message);
    }
  },

  renderQR(customer) {
    const container = document.getElementById('qr-canvas');
    container.innerHTML = '';
    const canvasEl = document.createElement('canvas');
    container.appendChild(canvasEl);

    try {
      new QRious({
        element: canvasEl,
        value: Utils.buildQRData(customer),
        size: 200,
        background: '#ffffff',
        foreground: '#1a1a2e',
        level: 'H',
        padding: 10,
      });
    } catch (err) {
      Toast.error('Lỗi tạo mã QR. Kiểm tra kết nối internet.');
      return;
    }

    document.getElementById('qr-customer-info').innerHTML = `
      <div class="info-row"><span class="info-label">Mã KH</span><span class="info-value">${customer.id}</span></div>
      <div class="info-row"><span class="info-label">Họ Tên</span><span class="info-value">${customer.name}</span></div>
      ${customer.phone ? `<div class="info-row"><span class="info-label">Điện Thoại</span><span class="info-value">${customer.phone}</span></div>` : ''}
      <div class="info-row"><span class="info-label">Loại KH</span><span class="info-value">${customer.type}</span></div>
      <div class="info-row"><span class="info-label">Ngày Tạo</span><span class="info-value">${Utils.formatDate(customer.createdAt)}</span></div>
    `;
    document.getElementById('qr-placeholder').classList.add('hidden');
    document.getElementById('qr-output').classList.remove('hidden');
  },

  hidePreview() {
    document.getElementById('qr-placeholder').classList.remove('hidden');
    document.getElementById('qr-output').classList.add('hidden');
    document.getElementById('qr-canvas').innerHTML = '';
    this.currentCustomer = null;
    document.getElementById('cust-id').value = Utils.generateId();
  },

  getQRCanvas: () => document.getElementById('qr-canvas').querySelector('canvas'),

  download() {
    const el = this.getQRCanvas();
    if (!el || !this.currentCustomer) { Toast.warning('Chưa có mã QR để tải!'); return; }
    const a = document.createElement('a');
    a.href = el.toDataURL('image/png');
    a.download = `QR_${this.currentCustomer.id}_${this.currentCustomer.name.replace(/\s+/g, '_')}.png`;
    a.click();
    Toast.success('Đã tải QR về máy!');
  },

  print() {
    if (!this.currentCustomer) return;
    const c = this.currentCustomer;
    const el = this.getQRCanvas();
    if (!el) { Toast.warning('Chưa có mã QR để in!'); return; }
    const imgSrc = el.toDataURL('image/png');
    const win = window.open('', '_blank', 'width=600,height=700');
    win.document.write(`<!DOCTYPE html><html><head><title>QR - ${c.name}</title>
      <style>
        body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
        .card{background:white;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:360px}
        .logo{font-size:18px;font-weight:800;color:#6366f1;margin-bottom:24px}
        img{width:200px;height:200px;border:3px solid #e2e8f0;padding:10px;border-radius:12px;margin-bottom:16px}
        .name{font-size:22px;font-weight:700;color:#1a1a2e;margin:0}.id{font-size:14px;color:#64748b;margin:4px 0 12px}
        .type{display:inline-block;padding:4px 16px;background:#ede9fe;color:#6366f1;border-radius:20px;font-size:12px;font-weight:600}
        .divider{border:none;border-top:1px dashed #e2e8f0;margin:16px 0}
        .info-row{display:flex;justify-content:space-between;font-size:13px;padding:4px 0}
        .info-label{color:#64748b}.info-value{font-weight:600;color:#1a1a2e}
        .footer{margin-top:20px;font-size:11px;color:#94a3b8}
        @media print{body{background:white}}
      </style></head><body>
      <div class="card">
        <div class="logo">QR Check-In Pro</div>
        <img src="${imgSrc}" alt="QR Code"/>
        <p class="name">${c.name}</p><p class="id">${c.id}</p>
        <span class="type">${c.type}</span><hr class="divider"/>
        <div>
          ${c.phone ? `<div class="info-row"><span class="info-label">Điện Thoại</span><span class="info-value">${c.phone}</span></div>` : ''}
          ${c.email ? `<div class="info-row"><span class="info-label">Email</span><span class="info-value">${c.email}</span></div>` : ''}
          <div class="info-row"><span class="info-label">Ngày Tạo</span><span class="info-value">${Utils.formatDate(c.createdAt)}</span></div>
        </div>
        <div class="footer">QR Check-In Pro System</div>
      </div>
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    win.document.close();
  },

  generateForExisting(customerId) {
    const customer = STATE.customers.find(c => c.id === customerId);
    if (!customer) return;
    Nav.navigate('generate');
    setTimeout(() => {
      document.getElementById('qr-placeholder').classList.remove('hidden');
      document.getElementById('qr-output').classList.add('hidden');
      document.getElementById('qr-canvas').innerHTML = '';
      document.getElementById('cust-name').value = customer.name;
      document.getElementById('cust-id').value = customer.id;
      document.getElementById('cust-phone').value = customer.phone || '';
      document.getElementById('cust-email').value = customer.email || '';
      document.getElementById('cust-type').value = customer.type || 'Thường';
      document.getElementById('cust-note').value = customer.note || '';
      this.currentCustomer = customer;
      this.renderQR(customer);
    }, 250);
  }
};

/* ============================================
   SCANNER
   ============================================ */
const Scanner = {
  html5QrCode: null,
  scanning: false,
  lastScanned: null,
  COOLDOWN_MS: 3000,

  init() {
    document.getElementById('btn-start-scan').addEventListener('click', () => this.start());
    document.getElementById('btn-stop-scan').addEventListener('click', () => this.stop());
    document.getElementById('btn-manual-input').addEventListener('click', () => this.toggleManual());
    document.getElementById('btn-upload-qr').addEventListener('click', () => document.getElementById('upload-qr-input').click());
    document.getElementById('upload-qr-input').addEventListener('change', e => this.scanFromFile(e.target.files[0]));
    document.getElementById('btn-manual-submit').addEventListener('click', () => this.processManual());
    document.getElementById('manual-id-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.processManual();
    });
  },

  async start() {
    if (this.scanning) return;
    const isHttps = location.protocol === 'https:' || location.hostname === 'localhost';
    if (!isHttps) {
      Toast.error('Camera chỉ hoạt động khi deploy lên HTTPS. Dùng "Quét từ ảnh" hoặc "Nhập thủ công".');
      document.getElementById('scanner-notice').classList.remove('hidden');
      return;
    }

    const readerEl = document.getElementById('qr-reader');
    const placeholder = document.getElementById('scanner-placeholder');
    const viewport = document.getElementById('scanner-viewport');

    readerEl.classList.remove('hidden');
    placeholder.classList.add('hidden');
    viewport.classList.add('scanning');
    document.getElementById('btn-start-scan').classList.add('hidden');
    document.getElementById('btn-stop-scan').classList.remove('hidden');

    this.html5QrCode = new Html5Qrcode('qr-reader');
    this.scanning = true;

    try {
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) { Toast.error('Không tìm thấy camera!'); this.stop(); return; }
      const cameraId = cameras.find(c => /back|rear|environment/i.test(c.label))?.id || cameras[0].id;
      await this.html5QrCode.start(
        cameraId,
        { fps: 10, qrbox: { width: 250, height: 250 } },
        decodedText => this.onScanSuccess(decodedText),
        () => {}
      );
      Toast.info('Camera đang hoạt động — Đưa mã QR vào khung quét');
    } catch (err) {
      console.error('Scanner error:', err);
      Toast.error('Không thể mở camera.');
      this.stop();
    }
  },

  async stop() {
    if (this.html5QrCode && this.scanning) {
      try { await this.html5QrCode.stop(); } catch { }
      this.html5QrCode = null;
    }
    this.scanning = false;
    const readerEl = document.getElementById('qr-reader');
    readerEl.classList.add('hidden');
    readerEl.innerHTML = '';
    document.getElementById('scanner-placeholder').classList.remove('hidden');
    document.getElementById('scanner-viewport').classList.remove('scanning');
    document.getElementById('btn-start-scan').classList.remove('hidden');
    document.getElementById('btn-stop-scan').classList.add('hidden');
  },

  scanFromFile(file) {
    if (!file) return;
    const scanner = new Html5Qrcode('qr-file-reader');
    scanner.scanFile(file, true)
      .then(text => {
        this.onScanSuccess(text);
        Toast.success('Đọc QR từ ảnh thành công!');
      })
      .catch(() => Toast.error('Không đọc được mã QR từ ảnh này.'))
      .finally(() => {
        document.getElementById('upload-qr-input').value = '';
      });
  },

  toggleManual() {
    const section = document.getElementById('manual-input-section');
    section.classList.toggle('hidden');
    if (!section.classList.contains('hidden')) document.getElementById('manual-id-input').focus();
  },

  processManual() {
    const input = document.getElementById('manual-id-input');
    const val = input.value.trim();
    if (!val) { Toast.warning('Nhập mã khách hàng'); return; }
    this.onScanSuccess(val);
    input.value = '';
  },

  onScanSuccess(decodedText) {
    const now = Date.now();
    if (this.lastScanned && (now - this.lastScanned.time < this.COOLDOWN_MS) && this.lastScanned.data === decodedText) return;
    this.lastScanned = { data: decodedText, time: now };
    this.processCheckIn(decodedText);
  },

  async processCheckIn(rawData) {
    const parsed = Utils.parseQRData(rawData);
    const customerId = parsed.id;
    const customer = STATE.customers.find(c => c.id.toLowerCase() === customerId.toLowerCase());

    if (!customer) {
      this.showResult('error', null, customerId);
      Toast.error(`Không tìm thấy khách hàng: ${customerId}`);
      return;
    }

    const checkIn = {
      id: `CI-${Date.now()}`,
      customerId: customer.id,
      customerName: customer.name,
      customerType: customer.type,
      customerPhone: customer.phone,
      timestamp: new Date().toISOString(),
      status: 'success',
    };

    customer.checkInCount = (customer.checkInCount || 0) + 1;
    customer.lastCheckIn = checkIn.timestamp;

    try {
      await Promise.all([
        StorageService.saveCheckIn(checkIn),
        StorageService.saveCustomer(customer),
      ]);
      if (STATE.storageMode === 'local') {
        STATE.checkIns.push(checkIn);
        Dashboard.refresh();
        SidebarStats.refresh();
      }
    } catch (err) {
      Toast.error('Lỗi lưu check-in: ' + err.message);
    }

    this.showResult('success', customer, null, checkIn);
    this.addToMiniHistory(customer, checkIn);
    Toast.success(`✓ Check-in: ${customer.name}`);

    // Tự động tắt camera sau khi quét thành công
    if (this.scanning) {
      // Flash viewport xanh lá để báo thành công
      const viewport = document.getElementById('scanner-viewport');
      if (viewport) {
        viewport.style.transition = 'border-color 0.15s ease, box-shadow 0.15s ease';
        viewport.style.borderColor = 'var(--accent-success)';
        viewport.style.boxShadow = '0 0 0 3px rgba(16,185,129,0.35), inset 0 0 40px rgba(16,185,129,0.1)';
      }
      // Dừng camera sau 1.8s
      setTimeout(async () => {
        await this.stop();
        if (viewport) {
          viewport.style.borderColor = '';
          viewport.style.boxShadow = '';
        }
      }, 1800);
    }

  },

  showResult(type, customer, unknownId, checkIn) {
    const display = document.getElementById('scan-result-display');
    if (type === 'success' && customer) {
      display.innerHTML = `
        <div class="result-success">
          <div class="result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="result-title">Check-in Thành Công!</div>
          <div class="result-details">
            <div class="result-detail-row"><span class="result-detail-label">Mã KH</span><span class="result-detail-value">${customer.id}</span></div>
            <div class="result-detail-row"><span class="result-detail-label">Họ Tên</span><span class="result-detail-value">${customer.name}</span></div>
            <div class="result-detail-row"><span class="result-detail-label">Loại KH</span><span class="result-detail-value">${Utils.getTypeBadge(customer.type)}</span></div>
            ${customer.phone ? `<div class="result-detail-row"><span class="result-detail-label">Điện Thoại</span><span class="result-detail-value">${customer.phone}</span></div>` : ''}
            <div class="result-detail-row"><span class="result-detail-label">Tổng Check-in</span><span class="result-detail-value">${customer.checkInCount} lần</span></div>
            <div class="result-detail-row"><span class="result-detail-label">Thời Gian</span><span class="result-detail-value">${Utils.formatTime(checkIn.timestamp)}</span></div>
          </div>
        </div>`;
    } else {
      display.innerHTML = `
        <div class="result-error">
          <div class="result-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
          <div class="result-title">Không Tìm Thấy!</div>
          <div class="result-details">
            <div class="result-detail-row"><span class="result-detail-label">Mã Quét</span><span class="result-detail-value text-danger">${unknownId || 'Không hợp lệ'}</span></div>
            <div class="result-detail-row"><span class="result-detail-label">Trạng Thái</span><span class="result-detail-value text-danger">Chưa đăng ký</span></div>
          </div>
        </div>`;
    }
  },

  addToMiniHistory(customer, checkIn) {
    const list = document.getElementById('scan-history-mini-list');
    const emptyP = list.querySelector('.empty-mini');
    if (emptyP) emptyP.remove();
    const item = document.createElement('div');
    item.className = 'mini-history-item';
    item.innerHTML = `<div class="mini-dot"></div><div class="mini-name">${customer.name}</div><div class="mini-time">${Utils.formatTime(checkIn.timestamp)}</div>`;
    list.insertBefore(item, list.firstChild);
    const items = list.querySelectorAll('.mini-history-item');
    if (items.length > 5) items[items.length - 1].remove();
  }
};

/* ============================================
   DASHBOARD
   ============================================ */
const Dashboard = {
  refresh() {
    const customers = STATE.customers;
    const checkIns = STATE.checkIns;
    const todayCI = checkIns.filter(c => Utils.isToday(c.timestamp));
    const checkedCustomers = new Set(checkIns.map(c => c.customerId)).size;
    const rate = customers.length > 0 ? Math.round((checkedCustomers / customers.length) * 100) : 0;

    this.animateValue('stat-customers-value', customers.length);
    this.animateValue('stat-today-value', todayCI.length);
    this.animateValue('stat-total-checkins-value', checkIns.length);
    document.getElementById('stat-rate-value').textContent = `${rate}%`;
    this.renderRecent(checkIns);
    this.renderHourlyChart(todayCI);
  },

  animateValue(id, targetVal) {
    const el = document.getElementById(id);
    if (!el) return;
    const current = parseInt(el.textContent) || 0;
    if (current === targetVal) { el.textContent = targetVal; return; }
    const step = (targetVal - current) / 20;
    let v = current;
    const timer = setInterval(() => {
      v += step;
      if ((step > 0 && v >= targetVal) || (step < 0 && v <= targetVal)) {
        el.textContent = targetVal; clearInterval(timer);
      } else { el.textContent = Math.round(v); }
    }, 20);
  },

  renderRecent(checkIns) {
    const container = document.getElementById('recent-checkins');
    const recent = [...checkIns].reverse().slice(0, 8);
    if (recent.length === 0) {
      container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg><p>Chưa có check-in nào</p></div>`;
      return;
    }
    container.innerHTML = recent.map(ci => `
      <div class="recent-item">
        <div class="recent-avatar" style="background:${Utils.getAvatarColor(ci.customerId)}">${Utils.getInitials(ci.customerName)}</div>
        <div class="recent-info"><div class="recent-name">${ci.customerName}</div><div class="recent-meta">${ci.customerId} · ${Utils.getTypeBadge(ci.customerType)}</div></div>
        <div class="recent-time">${Utils.timeAgo(ci.timestamp)}</div>
      </div>`).join('');
  },

  renderHourlyChart(todayCI) {
    const container = document.getElementById('hourly-chart');
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: todayCI.filter(ci => new Date(ci.timestamp).getHours() === h).length
    }));
    const maxCount = Math.max(...hours.map(h => h.count), 1);
    container.innerHTML = hours.map(h => {
      const pct = (h.count / maxCount) * 100;
      return `<div class="chart-bar-group" title="${h.hour}:00 — ${h.count} lượt">
        <div class="chart-bar-wrapper"><div class="chart-bar" style="height:${pct}%"></div></div>
        <div class="chart-label">${h.hour % 3 === 0 ? `${h.hour}h` : ''}</div>
      </div>`;
    }).join('');
  }
};

/* ============================================
   CUSTOMERS PAGE
   ============================================ */
const Customers = {
  searchQuery: '',
  filterType: '',
  init() {
    document.getElementById('customer-search').addEventListener('input', Utils.debounce(e => {
      this.searchQuery = e.target.value.toLowerCase(); this.render();
    }, 250));
    document.getElementById('customer-filter-type').addEventListener('change', e => {
      this.filterType = e.target.value; this.render();
    });
    document.getElementById('btn-export-customers').addEventListener('click', () => Excel.exportCustomers());
    document.getElementById('btn-export-header').addEventListener('click', () => {
      if (STATE.currentPage === 'customers') Excel.exportCustomers();
      else if (STATE.currentPage === 'history') Excel.exportHistory();
      else Excel.exportAll();
    });
  },
  render() {
    let data = STATE.customers;
    if (this.searchQuery) data = data.filter(c =>
      c.name.toLowerCase().includes(this.searchQuery) ||
      c.id.toLowerCase().includes(this.searchQuery) ||
      (c.phone && c.phone.includes(this.searchQuery)) ||
      (c.email && c.email.toLowerCase().includes(this.searchQuery))
    );
    if (this.filterType) data = data.filter(c => c.type === this.filterType);
    const tbody = document.getElementById('customers-tbody');
    if (data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>Không có khách hàng nào</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(c => `
      <tr>
        <td><strong style="color:var(--text-primary)">${c.id}</strong></td>
        <td><div style="display:flex;align-items:center;gap:10px">
          <div class="recent-avatar" style="background:${Utils.getAvatarColor(c.id)};width:32px;height:32px;font-size:12px;flex-shrink:0">${Utils.getInitials(c.name)}</div>
          <strong style="color:var(--text-primary)">${c.name}</strong></div></td>
        <td>${c.phone || '—'}</td>
        <td>${c.email || '—'}</td>
        <td>${Utils.getTypeBadge(c.type)}</td>
        <td><span class="badge badge-success">${c.checkInCount || 0}</span></td>
        <td>${c.lastCheckIn ? Utils.formatDateTime(c.lastCheckIn) : '—'}</td>
        <td><div class="table-actions">
          <button class="action-btn view" title="Chi tiết" onclick="Customers.viewDetail('${c.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="action-btn qr" title="Xem QR" onclick="QRGen.generateForExisting('${c.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="3" height="3" rx="0.5"/></svg>
          </button>
          <button class="action-btn delete" title="Xóa" onclick="Customers.delete('${c.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div></td>
      </tr>`).join('');
  },
  viewDetail(customerId) {
    const c = STATE.customers.find(x => x.id === customerId);
    if (!c) return;
    const customerCI = STATE.checkIns.filter(ci => ci.customerId === customerId);
    document.getElementById('customer-modal-body').innerHTML = `
      <div class="customer-detail-grid">
        <div class="detail-item"><div class="detail-label">Mã KH</div><div class="detail-value">${c.id}</div></div>
        <div class="detail-item"><div class="detail-label">Họ Tên</div><div class="detail-value">${c.name}</div></div>
        <div class="detail-item"><div class="detail-label">Điện Thoại</div><div class="detail-value">${c.phone || '—'}</div></div>
        <div class="detail-item"><div class="detail-label">Email</div><div class="detail-value">${c.email || '—'}</div></div>
        <div class="detail-item"><div class="detail-label">Loại KH</div><div class="detail-value">${Utils.getTypeBadge(c.type)}</div></div>
        <div class="detail-item"><div class="detail-label">Tổng Check-in</div><div class="detail-value">${c.checkInCount || 0} lần</div></div>
        <div class="detail-item"><div class="detail-label">Ngày Đăng Ký</div><div class="detail-value">${Utils.formatDateTime(c.createdAt)}</div></div>
        <div class="detail-item"><div class="detail-label">Check-in Cuối</div><div class="detail-value">${c.lastCheckIn ? Utils.formatDateTime(c.lastCheckIn) : '—'}</div></div>
        ${c.note ? `<div class="detail-item" style="grid-column:span 2"><div class="detail-label">Ghi Chú</div><div class="detail-value">${c.note}</div></div>` : ''}
      </div>
      ${customerCI.length > 0 ? `
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:10px">Lịch Sử Check-in (${customerCI.length} lần)</h4>
        <div style="max-height:180px;overflow-y:auto">
          ${[...customerCI].reverse().slice(0, 10).map((ci, i) => `
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
              <span style="color:var(--text-muted)">#${customerCI.length - i}</span>
              <span>${Utils.formatDateTime(ci.timestamp)}</span>
              <span class="badge badge-success">✓</span>
            </div>`).join('')}
        </div>` : '<p style="color:var(--text-muted);font-size:13px">Chưa có lịch sử check-in</p>'}`;
    document.getElementById('customer-modal').classList.remove('hidden');
  },
  async delete(customerId) {
    const c = STATE.customers.find(x => x.id === customerId);
    if (!c) return;
    const ok = await Confirm.show('Xóa Khách Hàng', `Bạn có chắc muốn xóa "${c.name}" (${c.id})?`);
    if (!ok) return;
    try {
      await StorageService.deleteCustomer(customerId);
      if (STATE.storageMode === 'local') {
        STATE.customers = STATE.customers.filter(x => x.id !== customerId);
        this.render(); SidebarStats.refresh(); Dashboard.refresh();
      }
      Toast.success(`Đã xóa ${c.name}`);
    } catch (err) { Toast.error('Lỗi xóa: ' + err.message); }
  }
};

/* ============================================
   HISTORY PAGE
   ============================================ */
const History = {
  searchQuery: '',
  dateFilter: '',
  init() {
    document.getElementById('history-search').addEventListener('input', Utils.debounce(e => {
      this.searchQuery = e.target.value.toLowerCase(); this.render();
    }, 250));
    document.getElementById('history-date-filter').addEventListener('change', e => {
      this.dateFilter = e.target.value; this.render();
    });
    document.getElementById('btn-export-history').addEventListener('click', () => Excel.exportHistory());
    document.getElementById('btn-clear-history').addEventListener('click', async () => {
      const ok = await Confirm.show('Xóa Lịch Sử', 'Toàn bộ lịch sử check-in sẽ bị xóa vĩnh viễn!');
      if (!ok) return;
      try {
        await StorageService.clearCheckIns();
        if (STATE.storageMode === 'local') { STATE.checkIns = []; }
        this.render(); Dashboard.refresh(); SidebarStats.refresh();
        Toast.success('Đã xóa toàn bộ lịch sử check-in');
      } catch (err) { Toast.error('Lỗi: ' + err.message); }
    });
  },
  render() {
    let data = [...STATE.checkIns].reverse();
    if (this.searchQuery) data = data.filter(ci =>
      ci.customerName.toLowerCase().includes(this.searchQuery) ||
      ci.customerId.toLowerCase().includes(this.searchQuery) ||
      (ci.customerPhone && ci.customerPhone.includes(this.searchQuery))
    );
    if (this.dateFilter) data = data.filter(ci => ci.timestamp.startsWith(this.dateFilter));
    const tbody = document.getElementById('history-tbody');
    if (data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/></svg><p>Không có dữ liệu</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((ci, i) => `
      <tr>
        <td style="color:var(--text-muted)">${data.length - i}</td>
        <td><strong style="color:var(--text-primary)">${ci.customerId}</strong></td>
        <td><div style="display:flex;align-items:center;gap:8px">
          <div class="recent-avatar" style="background:${Utils.getAvatarColor(ci.customerId)};width:28px;height:28px;font-size:10px;flex-shrink:0">${Utils.getInitials(ci.customerName)}</div>
          ${ci.customerName}</div></td>
        <td>${Utils.getTypeBadge(ci.customerType)}</td>
        <td>${ci.customerPhone || '—'}</td>
        <td style="color:var(--text-primary);font-variant-numeric:tabular-nums">${Utils.formatDateTime(ci.timestamp)}</td>
        <td><span class="badge badge-success">✓ Đã vào</span></td>
      </tr>`).join('');
  }
};

/* ============================================
   SETTINGS PAGE
   ============================================ */
const Settings = {
  render() {
    const isFirebase = STATE.storageMode === 'firebase';
    const cfg = window.FIREBASE_CONFIG || {};
    document.getElementById('settings-content').innerHTML = `
      <div class="settings-section">
        <h3>Trạng Thái Lưu Trữ</h3>
        <div class="settings-status-card ${isFirebase ? 'status-cloud' : 'status-local'}">
          <div class="status-icon">${isFirebase ? '☁' : '⊙'}</div>
          <div>
            <div class="status-title">${isFirebase ? 'Cloud (Firebase)' : 'Local (Máy tính này)'}</div>
            <div class="status-desc">${isFirebase
              ? `Project: ${cfg.projectId} — Đồng bộ real-time`
              : 'Dữ liệu chỉ lưu trên trình duyệt này'}</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Cấu Hình Firebase Cloud</h3>
        <p class="settings-desc">
          Nhập thông tin Firebase để đồng bộ dữ liệu giữa nhiều thiết bị và bật camera quét QR khi deploy.
          <a href="https://console.firebase.google.com" target="_blank" class="settings-link">→ Tạo project Firebase miễn phí</a>
        </p>
        <div class="settings-form">
          <div class="form-group"><label>API Key</label><input type="text" id="fb-apiKey" placeholder="AIza..." value="${cfg.apiKey || ''}"/></div>
          <div class="form-group"><label>Auth Domain</label><input type="text" id="fb-authDomain" placeholder="project.firebaseapp.com" value="${cfg.authDomain || ''}"/></div>
          <div class="form-group"><label>Project ID</label><input type="text" id="fb-projectId" placeholder="my-project-id" value="${cfg.projectId || ''}"/></div>
          <div class="form-group"><label>Storage Bucket</label><input type="text" id="fb-storageBucket" placeholder="project.appspot.com" value="${cfg.storageBucket || ''}"/></div>
          <div class="form-group"><label>Messaging Sender ID</label><input type="text" id="fb-messagingSenderId" placeholder="123456789" value="${cfg.messagingSenderId || ''}"/></div>
          <div class="form-group"><label>App ID</label><input type="text" id="fb-appId" placeholder="1:123:web:abc" value="${cfg.appId || ''}"/></div>
          <div class="settings-actions">
            <button class="btn btn-primary" onclick="Settings.saveFirebase()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Lưu & Kết Nối Firebase
            </button>
            ${isFirebase ? `<button class="btn btn-danger-ghost" onclick="Settings.disconnectFirebase()">Ngắt kết nối</button>` : ''}
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Dữ Liệu Hiện Tại</h3>
        <div class="settings-stats">
          <div class="settings-stat"><span class="settings-stat-val">${STATE.customers.length}</span><span class="settings-stat-lbl">Khách hàng</span></div>
          <div class="settings-stat"><span class="settings-stat-val">${STATE.checkIns.length}</span><span class="settings-stat-lbl">Check-ins</span></div>
        </div>
        <div class="settings-actions" style="margin-top:16px">
          <button class="btn btn-ghost" onclick="Excel.exportAll()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Xuất Tất Cả Excel
          </button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Hướng Dẫn Deploy</h3>
        <div class="deploy-steps">
          <div class="deploy-step"><span class="step-num">1</span><div><strong>Tạo Firebase project</strong> tại <a href="https://console.firebase.google.com" target="_blank" class="settings-link">console.firebase.google.com</a></div></div>
          <div class="deploy-step"><span class="step-num">2</span><div><strong>Bật Firestore Database</strong> → Create database → Test mode</div></div>
          <div class="deploy-step"><span class="step-num">3</span><div><strong>Copy config</strong> từ Project Settings → General → Your apps → Web → dán vào form trên</div></div>
          <div class="deploy-step"><span class="step-num">4</span><div><strong>Deploy lên Vercel</strong>: Truy cập <a href="https://vercel.com" target="_blank" class="settings-link">vercel.com</a> → kéo thả thư mục → Done!</div></div>
        </div>
      </div>
    `;
  },

  saveFirebase() {
    const config = {
      apiKey: document.getElementById('fb-apiKey').value.trim(),
      authDomain: document.getElementById('fb-authDomain').value.trim(),
      projectId: document.getElementById('fb-projectId').value.trim(),
      storageBucket: document.getElementById('fb-storageBucket').value.trim(),
      messagingSenderId: document.getElementById('fb-messagingSenderId').value.trim(),
      appId: document.getElementById('fb-appId').value.trim(),
    };
    if (!config.apiKey || !config.projectId) {
      Toast.warning('Vui lòng nhập ít nhất API Key và Project ID'); return;
    }
    localStorage.setItem('qr_firebase_config', JSON.stringify(config));
    Toast.info('Đã lưu cấu hình. Đang reload để kết nối Firebase...');
    setTimeout(() => location.reload(), 1500);
  },

  disconnectFirebase() {
    localStorage.removeItem('qr_firebase_config');
    Toast.info('Đã ngắt kết nối. Đang reload...');
    setTimeout(() => location.reload(), 1500);
  }
};

/* ============================================
   EXCEL EXPORT
   ============================================ */
const Excel = {
  exportCustomers() {
    if (STATE.customers.length === 0) { Toast.warning('Không có dữ liệu khách hàng'); return; }
    const data = STATE.customers.map((c, i) => ({
      'STT': i + 1, 'Mã Khách Hàng': c.id, 'Họ Và Tên': c.name,
      'Số Điện Thoại': c.phone || '', 'Email': c.email || '',
      'Loại Khách Hàng': c.type, 'Số Lần Check-in': c.checkInCount || 0,
      'Lần Check-in Cuối': c.lastCheckIn ? Utils.formatDateTime(c.lastCheckIn) : '',
      'Ngày Đăng Ký': Utils.formatDateTime(c.createdAt), 'Ghi Chú': c.note || '',
    }));
    this.toXLSX(data, 'Danh_Sach_Khach_Hang', 'Khách Hàng');
    Toast.success(`Đã xuất ${data.length} khách hàng!`);
  },
  exportHistory() {
    if (STATE.checkIns.length === 0) { Toast.warning('Không có lịch sử'); return; }
    const data = [...STATE.checkIns].reverse().map((ci, i) => ({
      'STT': i + 1, 'Mã KH': ci.customerId, 'Họ Và Tên': ci.customerName,
      'Loại KH': ci.customerType, 'Điện Thoại': ci.customerPhone || '',
      'Thời Gian': Utils.formatDateTime(ci.timestamp),
      'Ngày': Utils.formatDate(ci.timestamp), 'Giờ': Utils.formatTime(ci.timestamp),
      'Trạng Thái': 'Đã Vào',
    }));
    this.toXLSX(data, 'Lich_Su_Check_In', 'Lịch Sử');
    Toast.success(`Đã xuất ${data.length} lượt check-in!`);
  },
  exportAll() {
    if (STATE.customers.length === 0 && STATE.checkIns.length === 0) { Toast.warning('Không có dữ liệu'); return; }
    const wb = XLSX.utils.book_new();
    if (STATE.customers.length > 0) {
      const ws = XLSX.utils.json_to_sheet(STATE.customers.map((c, i) => ({
        'STT': i + 1, 'Mã KH': c.id, 'Họ Tên': c.name, 'ĐT': c.phone || '',
        'Loại': c.type, 'Check-ins': c.checkInCount || 0,
      })));
      this.styleSheet(ws);
      XLSX.utils.book_append_sheet(wb, ws, 'Khách Hàng');
    }
    if (STATE.checkIns.length > 0) {
      const ws = XLSX.utils.json_to_sheet([...STATE.checkIns].reverse().map((ci, i) => ({
        'STT': i + 1, 'Mã KH': ci.customerId, 'Họ Tên': ci.customerName,
        'Loại': ci.customerType, 'Thời Gian': Utils.formatDateTime(ci.timestamp),
      })));
      this.styleSheet(ws);
      XLSX.utils.book_append_sheet(wb, ws, 'Lịch Sử Check-in');
    }
    const ws3 = XLSX.utils.json_to_sheet([
      { 'Thống Kê': 'Tổng Khách Hàng', 'Giá Trị': STATE.customers.length },
      { 'Thống Kê': 'Tổng Check-in', 'Giá Trị': STATE.checkIns.length },
      { 'Thống Kê': 'Ngày Xuất', 'Giá Trị': new Date().toLocaleString('vi-VN') },
      { 'Thống Kê': 'Chế Độ Lưu', 'Giá Trị': STATE.storageMode === 'firebase' ? 'Firebase Cloud' : 'Local' },
    ]);
    XLSX.utils.book_append_sheet(wb, ws3, 'Tóm Tắt');
    XLSX.writeFile(wb, `QR_CheckIn_Report_${new Date().toISOString().slice(0, 10)}.xlsx`);
    Toast.success('Đã xuất báo cáo tổng hợp Excel!');
  },
  styleSheet(ws) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const colWidths = [];
    for (let C = range.s.c; C <= range.e.c; C++) {
      let maxW = 10;
      for (let R = range.s.r; R <= range.e.r; R++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (cell && cell.v) maxW = Math.max(maxW, String(cell.v).length);
      }
      colWidths.push({ wch: Math.min(maxW + 2, 40) });
    }
    ws['!cols'] = colWidths;
  },
  toXLSX(data, filename, sheetName) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    this.styleSheet(ws);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
};

/* ============================================
   SIDEBAR STATS & CLOCK
   ============================================ */
const SidebarStats = {
  refresh() {
    document.getElementById('sidebar-total').textContent = STATE.customers.length;
    document.getElementById('sidebar-checkins').textContent = STATE.checkIns.length;
  }
};

const Clock = {
  init() {
    this.update();
    setInterval(() => this.update(), 1000);
  },
  update() {
    const el = document.getElementById('header-time');
    if (el) el.textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
};

/* ============================================
   MODALS
   ============================================ */
const Modals = {
  init() {
    document.getElementById('confirm-cancel').addEventListener('click', () => Confirm.close(false));
    document.getElementById('confirm-ok').addEventListener('click', () => Confirm.close(true));
    document.getElementById('customer-modal-close').addEventListener('click', () => {
      document.getElementById('customer-modal').classList.add('hidden');
    });
    document.getElementById('confirm-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) Confirm.close(false);
    });
    document.getElementById('customer-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) document.getElementById('customer-modal').classList.add('hidden');
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        Confirm.close(false);
        document.getElementById('customer-modal').classList.add('hidden');
      }
    });
  }
};

/* ============================================
   CONNECTING BADGE STYLE
   ============================================ */
(function() {
  const s = document.createElement('style');
  s.textContent = `
    .badge-connecting {
      display:inline-flex;align-items:center;gap:6px;
      padding:4px 10px;border-radius:20px;
      background:rgba(99,102,241,0.15);color:#818cf8;
      font-size:12px;font-weight:600;border:1px solid rgba(99,102,241,0.3);
      animation:pulse-badge 1.2s ease-in-out infinite;
    }
    @keyframes pulse-badge{0%,100%{opacity:1}50%{opacity:0.5}}
  `;
  document.head.appendChild(s);
})();

/* ============================================
   FIREBASE CONFIG FROM LOCALSTORAGE (override)
   Cho phép user nhập config qua UI, lưu localStorage
   ============================================ */
function loadFirebaseConfigFromStorage() {
  try {
    const saved = localStorage.getItem('qr_firebase_config');
    if (saved) {
      const cfg = JSON.parse(saved);
      window.FIREBASE_CONFIG = cfg;
      window.IS_FIREBASE_CONFIGURED = !!(cfg.apiKey && cfg.projectId);
    }
  } catch { }
}

/* ============================================
   DEMO DATA
   ============================================ */
const Demo = {
  async load() {
    if (STATE.customers.length > 0) return;
    const now = Date.now();
    const sampleCustomers = [
      { id: 'KH-001', name: 'Nguyễn Văn An', phone: '0912 345 678', email: 'an.nguyen@email.com', type: 'VIP', note: 'Khách thân thiết', createdAt: new Date(now - 86400000 * 5).toISOString(), checkInCount: 3, lastCheckIn: new Date(now - 3600000).toISOString() },
      { id: 'KH-002', name: 'Trần Thị Bình', phone: '0987 654 321', email: 'binh.tran@email.com', type: 'VVIP', note: '', createdAt: new Date(now - 86400000 * 3).toISOString(), checkInCount: 1, lastCheckIn: new Date(now - 7200000).toISOString() },
      { id: 'KH-003', name: 'Lê Hoàng Cường', phone: '0356 789 012', email: '', type: 'Thường', note: '', createdAt: new Date(now - 86400000 * 2).toISOString(), checkInCount: 2, lastCheckIn: new Date(now - 1800000).toISOString() },
      { id: 'KH-004', name: 'Phạm Thị Dung', phone: '0701 234 567', email: 'dung.pham@email.com', type: 'Đại Lý', note: 'Đại lý miền Nam', createdAt: new Date(now - 86400000).toISOString(), checkInCount: 0, lastCheckIn: null },
      { id: 'KH-005', name: 'Hoàng Minh Đức', phone: '0812 345 678', email: '', type: 'Nhân Viên', note: '', createdAt: new Date(now - 43200000).toISOString(), checkInCount: 1, lastCheckIn: new Date(now - 900000).toISOString() },
    ];
    const sampleCI = [
      { id: 'CI-001', customerId: 'KH-001', customerName: 'Nguyễn Văn An', customerType: 'VIP', customerPhone: '0912 345 678', timestamp: new Date(now - 3600000).toISOString(), status: 'success' },
      { id: 'CI-002', customerId: 'KH-002', customerName: 'Trần Thị Bình', customerType: 'VVIP', customerPhone: '0987 654 321', timestamp: new Date(now - 7200000).toISOString(), status: 'success' },
      { id: 'CI-003', customerId: 'KH-003', customerName: 'Lê Hoàng Cường', customerType: 'Thường', customerPhone: '0356 789 012', timestamp: new Date(now - 1800000).toISOString(), status: 'success' },
      { id: 'CI-004', customerId: 'KH-001', customerName: 'Nguyễn Văn An', customerType: 'VIP', customerPhone: '0912 345 678', timestamp: new Date(now - 900000).toISOString(), status: 'success' },
      { id: 'CI-005', customerId: 'KH-005', customerName: 'Hoàng Minh Đức', customerType: 'Nhân Viên', customerPhone: '0812 345 678', timestamp: new Date(now - 600000).toISOString(), status: 'success' },
    ];
    for (const c of sampleCustomers) await StorageService.saveCustomer(c);
    for (const ci of sampleCI) await StorageService.saveCheckIn(ci);
    STATE.customers = sampleCustomers;
    STATE.checkIns = sampleCI;
  }
};

/* ============================================
   APP INIT
   ============================================ */
const App = {
  async init() {
    try {
      loadFirebaseConfigFromStorage();

      // ══ FASE 1: UI NGAY LẬP TỨC (không await gì) ══
      // Khởi tạo Local adapter trước để có data hiển thị ngay
      StorageService.adapter = LocalAdapter;
      STATE.storageMode = 'local';

      // Load dữ liệu local (nhanh, không cần network)
      [STATE.customers, STATE.checkIns] = await Promise.all([
        LocalAdapter.getCustomers(),
        LocalAdapter.getCheckIns(),
      ]);

      // Init tất cả UI modules — TAB VÀ NÚT HOẠT ĐỘNG NGAY
      Nav.init();
      QRGen.init();
      Scanner.init();
      Customers.init();
      History.init();
      Modals.init();
      Clock.init();

      // Render giao diện với local data
      StorageService._subscribe();
      StorageService._updateStatusBadge();
      Dashboard.refresh();
      SidebarStats.refresh();

      console.log('✅ QR Check-In Pro UI ready — Local mode');

      // ══ FASE 2: KẾT NỐI FIREBASE Ở NỀN (không block UI) ══
      if (window.IS_FIREBASE_CONFIGURED) {
        // ⚠️ KHÔNG gọi Demo.load() ở đây khi Firebase được cấu hình
        // Demo sẽ được kiểm tra SAU khi biết Firebase có rỗng không
        StorageService._setConnectingBadge(true);

        FirebaseAdapter.init().then(() => {
          // Chuyển sang Firebase adapter
          STATE.unsubscribers.forEach(fn => fn());
          STATE.unsubscribers = [];

          StorageService.adapter = FirebaseAdapter;
          STATE.storageMode = 'firebase';
          STATE.firebaseReady = true;

          // Load lại data từ Firebase
          return Promise.all([
            FirebaseAdapter.getCustomers(),
            FirebaseAdapter.getCheckIns(),
          ]).then(([customers, checkIns]) => {
            STATE.customers = customers;
            STATE.checkIns = checkIns;
            StorageService._subscribe();
            StorageService._setConnectingBadge(false);
            Dashboard.refresh();
            SidebarStats.refresh();
            if (STATE.currentPage === 'customers') Customers.render();
            if (STATE.currentPage === 'history') History.render();
            Toast.success('✅ Đã kết nối Firebase Cloud!');
            console.log('✅ Switched to Firebase mode');

            // Chỉ load demo nếu Firebase CŨNG rỗng (project mới hoàn toàn)
            // Điều này tránh ghi đè data thật của user
            if (STATE.customers.length === 0) {
              Demo.load().then(() => {
                Dashboard.refresh();
                SidebarStats.refresh();
              }).catch(err => console.warn('Demo load:', err));
            }
          });

        }).catch(err => {
          StorageService._setConnectingBadge(false);
          const isTimeout = err.message && err.message.includes('timeout');
          if (isTimeout) {
            Toast.error('⏱ Firebase timeout — Kiểm tra Firestore đã bật chưa. Đang dùng Local.');
          } else {
            Toast.error('Lỗi Firebase: ' + err.message.slice(0, 80));
          }
          console.warn('Firebase failed:', err.message);
          // Firebase thất bại → fallback local, load demo nếu rỗng
          if (STATE.customers.length === 0) {
            Demo.load().then(() => {
              Dashboard.refresh();
              SidebarStats.refresh();
            }).catch(err => console.warn('Demo load:', err));
          }
        });
      } else {
        // Local mode (không có Firebase) → load demo nếu local rỗng
        Demo.load().then(() => {
          Dashboard.refresh();
          SidebarStats.refresh();
        }).catch(err => console.warn('Demo load:', err));
      }

    } catch (err) {
      console.error('❌ App init error:', err);
      // Vẫn cố init UI để không bị kẹt
      try { Nav.init(); } catch {}
      try { Modals.init(); } catch {}
      try { Clock.init(); } catch {}
      Toast && Toast.error('Lỗi khởi động: ' + (err.message || err).toString().slice(0, 100));
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());

