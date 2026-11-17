# omp-jailbreak

Plugin OMP yang menyinkronkan repo profil [jailbreaks](https://github.com/togg53192-cmd/jailbreaks) lalu menyuntikkan profil Markdown yang cocok ke system prompt setiap kali prompt dikirim.

Alurnya:

1. Plugin dimuat.
2. `session_start` → cek repo. Clone kalau belum ada, `fetch` + fast-forward kalau ada update.
3. Setiap `before_agent_start` → baca model aktif (`provider`, `id`, `name`, `identity`).
4. Resolver memilih satu file `.md` yang paling cocok.
5. Isi file ditambahkan ke system prompt request tersebut.
6. Model berganti → resolver jalan lagi, file baru dibaca, injeksi ikut berganti.

## Fitur

- Injeksi profil per prompt, bukan sekali per sesi.
- Indikator status di footer: `🔓 Jailbreak ON` saat profil aktif, `🔒 Jailbreak OFF` saat tidak ada profil cocok.
- Deteksi model langsung dari sesi OMP; tidak perlu konfigurasi nama model.
- Sinkronisasi repo otomatis saat sesi mulai.
- Update repo otomatis terdeteksi lewat `git fetch`; pull hanya jika HEAD berubah.
- Cache isi file berbasis `mtime` + `size`, jadi file yang tidak berubah tidak dibaca ulang.
- Command `/jailbreak` untuk melihat pemetaan model aktif.
- Command `/jailbreak sync` untuk memaksa cek update.
- Kegagalan git tidak mematikan sesi; plugin lanjut memakai clone lama bila ada.

## Tech Stack

- **Runtime**: Bun (dijalankan di dalam proses OMP)
- **Bahasa**: TypeScript
- **API host**: `@oh-my-pi/pi-coding-agent` (type-only)
- **Sumber data**: git clone repo jailbreaks
- **Test**: `bun test`

## Prasyarat

- OMP 18.x atau lebih baru.
- `git` tersedia di `PATH`.
- Akses jaringan ke GitHub untuk clone/pull pertama.
- Bun, hanya jika ingin menjalankan test.

## Instalasi

### Mode development (link lokal)

```bash
cd C:\Users\mfarr\orca\projects\omp-jb
omp plugin link .
omp plugin list
```

`omp plugin link` membuat symlink paket ini ke `~/.omp/plugins/node_modules/omp-jailbreak` dan menambahkan entri runtime ke `omp-plugins.lock.json`.

Mulai sesi OMP baru. Pada sesi pertama plugin akan clone repo ke:

```text
~/.omp/jailbreak-omp/repo
```

### Instalasi dari git

Pasang plugin langsung dari repo plugin:

```bash
omp plugin install github:<user>/<repo-plugin>
```

### Verifikasi terpasang

```bash
omp plugin list
```

Cari entri `omp-jailbreak` dengan status enabled. Di sesi OMP, jalankan:

```text
/jailbreak
```

Output contoh:

```text
deepseek-v4.1-flash -> DeepSeek/deepseek-4-1.md (score 13)
```

## Konfigurasi

| Variabel | Default | Fungsi |
|---|---|---|
| `OMP_JAILBREAK_DIR` | `~/.omp/jailbreak-omp` | Root cache. Clone berada di `<root>/repo`. |

Tidak ada file config tambahan. Pemilihan profil sepenuhnya otomatis.

## Cara kerja

### Sinkronisasi repo

`syncRepo()` di `src/core.ts`:

1. Jika `<root>/repo/.git` tidak ada → `git clone --depth 1 --single-branch`.
2. Jika ada → `git fetch --depth 1 origin HEAD`.
3. Bandingkan `HEAD` dengan `FETCH_HEAD`.
4. Sama → status `current`.
5. Beda → `git merge --ff-only FETCH_HEAD`; kalau histori ditulis ulang, cache di-`reset --hard` ke `FETCH_HEAD` (cache milik plugin, bukan working tree pengguna).
6. Gagal jaringan → status `offline`, clone lama tetap dipakai.

`GIT_TERMINAL_PROMPT=0` dipasang agar git tidak menggantung menunggu kredensial.

### Pemilihan profil

Resolver menerima signature:

```text
<provider> <id> <name> <identity.class> <identity.family> <identity.revision>
```

Contoh untuk model aktif:

```text
freepi deepseek-v4.1-flash DeepSeek V4.1 Flash deepseek deepseek 4.1
```

Skoring terhadap setiap path `.md`:

| Komponen | Bobot |
|---|---|
| Token keluarga sama persis, panjang ≥ 4 | +5 |
| Token keluarga sama persis, panjang 2–3 | +2 |
| Prefiks token keluarga (mis. `deepseekv4` vs `deepseek`) | +3 |
| Angka versi yang sama | +1 per angka |
| Deret versi model muncul utuh di nama file | +6 |
| Mayor sama, minor beda | +2 |
| Mayor file lebih baru dari model | −4 |
| Mayor file lebih lama | −2 |

Syarat minimum: satu token keluarga kuat. Tanpa itu, tidak ada injeksi. Ini mencegah profil acak dipakai untuk model yang tidak dikenal.

Token umum (`agents`, `prompt`, `system`, `opencode`, `policy`, dan sejenisnya) diabaikan agar tidak menang melawan nama keluarga model.

Seri: skor tertinggi menang; jika sama, path yang lebih kecil secara leksikografis dipakai supaya hasil deterministik.

### Injeksi

Handler `before_agent_start` mengembalikan system prompt baru:

```text
<jailbreak_profile model="DeepSeek V4.1 Flash" source="DeepSeek/deepseek-4-1.md">
...isi Markdown...
</jailbreak_profile>
```

Blok ditambahkan ke array `systemPrompt` yang sudah ada. Base system prompt OMP tidak dihapus.

### Perubahan model

Tidak ada event khusus model switch yang dibutuhkan. Setiap prompt memanggil `ctx.models.current()`, sehingga pergantian model melalui `/model` langsung terlihat pada prompt berikutnya.

## Struktur proyek

```text
omp-jb/
├── extensions/
│   └── jailbreak.ts      # Handler OMP: sync, injeksi, command
├── src/
│   └── core.ts           # Git sync, scan profil, resolver, cache, render
├── test/
│   └── resolve.test.ts   # Test resolver
├── package.json          # Manifest omp.extensions
└── README.md
```

## Command

| Command | Fungsi |
|---|---|
| `/jailbreak` | Tampilkan model aktif, file profil, dan skor. |
| `/jailbreak sync` | Paksa fetch + pull, lalu tampilkan jumlah profil dan HEAD. |

## Test

```bash
bun test
```

Test mencakup:

- DeepSeek 4.1 tidak tertukar dengan v4 atau v3.
- Qwen 3.8 tidak tertukar dengan Qwen 4.
- GLM 5.2 tidak tertukar dengan GLM 5.3.
- Nama model stealth multi-kata.
- Model tak dikenal menghasilkan `undefined`.

## Troubleshooting

### Profil tidak muncul

1. Jalankan `/jailbreak`.
2. Jika "no matching profile": repo belum punya file untuk keluarga model tersebut. Jalankan `/jailbreak sync`; kalau tetap tidak ada, tambahkan file baru ke repo.
3. Jika jumlah profil 0: cek `~/.omp/jailbreak-omp/repo` dan pastikan git bisa clone.

### Sync gagal

Pesan `Jailbreak repo sync failed` berarti `git` gagal. Periksa:

```bash
git --version
git ls-remote https://github.com/togg53192-cmd/jailbreaks.git HEAD
```

Clone lama tetap dipakai selama direktori ada.

### Perubahan file tidak terbaca

Cache memakai `mtime` + `size`. Setelah pull, file yang berubah otomatis dibaca ulang pada prompt berikutnya.

### System prompt membengkak

Setiap prompt membawa satu file profil penuh, sesuai desain. Ukuran file bervariasi; profil besar menambah token per request. Jika perlu, kecilkan file sumber atau batasi pemilihan ke profil yang lebih ringkas.

### Plugin tidak termuat

```bash
omp plugin doctor
```

Penyebab umum: `package.json` tidak punya `omp.extensions`, path entry salah, atau factory melempar error saat load.
