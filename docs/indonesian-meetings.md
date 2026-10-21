# Rapat Indonesia, notulen bersumber, dan tindak lanjut

Paket enrichment pertama OpenPlaud memperluas alur yang sudah ada. Audio asli dan
versi transkrip tetap dipertahankan; dokumen AI tetap harus ditinjau sebelum disimpan.

## Cara menggunakan

1. Di Settings, pilih Bahasa Indonesia untuk antarmuka.
2. Buat profil transkripsi dari preset **Rapat (Bahasa Indonesia)**. Tambahkan nama
   organisasi, proyek, dan singkatan ke kosakata profil. Kemampuan bahasa, prompt,
   dan pemisahan pembicara tetap mengikuti penyedia/model yang dipilih.
3. Impor dan transkripsikan rekaman. Tinjau nama, angka, serta pergantian pembicara.
4. Dari transkrip, buat dokumen dengan gaya **Notulen rapat Indonesia**. Model diminta
   membedakan pembahasan, keputusan, tindak lanjut, dan pertanyaan terbuka.
5. Tinjau kutipan sumber dan isi notulen sebelum menyimpan. Dokumen disimpan dengan
   referensi ke rekaman dan versi transkrip sumbernya.
6. Gunakan ekstraksi action items yang sudah tersedia di studio transkrip, lalu
   tinjau draft di Automations. Tetapkan PIC dan tanggal secara eksplisit, setujui
   draft, kemudian perbarui status pengerjaannya.

## Perilaku dan batasan

- Kutipan Markdown pada template notulen Indonesia diperiksa terhadap teks sumber
  (spasi dinormalisasi). Kutipan yang hilang atau tidak cocok menggagalkan generasi.
  Pemeriksaan ini membuktikan kecocokan kata, **bukan** bahwa semua interpretasi AI
  benar atau setiap klaim telah didukung kutipan. Peninjauan manusia tetap diperlukan.
- Template tidak membuat timestamp, PIC, atau tanggal yang tidak tersedia. Kutipan
  mempertahankan bahasa asli, sedangkan narasi diminta dalam Bahasa Indonesia.
- Saran judul/tag untuk transkrip panjang menggunakan lima cuplikan berurutan yang
  mencakup awal, tengah, dan akhir, dengan batas total 24.000 karakter termasuk
  penanda bagian yang dilewati. Ini bukan pembacaan seluruh isi dan bukan ringkasan
  bertingkat. Batas generasi dokumen 100 KB tetap berlaku.
- Pencarian kata kunci dan topik menyaring kata umum Indonesia; istilah domain dan
  negasi seperti `belum` serta `tidak` dipertahankan. Belum ada stemming, kamus
  sinonim organisasi, atau benchmark akurasi audio Indonesia nyata.
- Status persetujuan (`draft`, `approved`, `dismissed`) terpisah dari pengerjaan
  (`todo`, `in_progress`, `blocked`, `done`). Perubahan isi membutuhkan peninjauan
  ulang; perubahan pengerjaan saja mempertahankan persetujuan.
- Penanda terlambat berlaku untuk tugas disetujui yang belum selesai dengan tanggal
  sebelum hari berjalan menurut UTC. Status ini dihitung ulang saat data dimuat.
- Progres tugas bersifat lokal; perubahan tidak otomatis disinkronkan kembali ke
  Todoist, Linear, atau Notion. Ekspor tetap merupakan tindakan eksplisit.

## Validasi

Pengujian mencakup profil Indonesia, pencarian, cuplikan akhir rapat, penolakan kutipan
palsu, provenance versi sumber, migrasi tugas, serta pemisahan progres dan persetujuan.
Build dan pemeriksaan tipe dijalankan pada Windows. Pengujian dengan perangkat Plaud
fisik dan penyedia AI nyata belum dilakukan.

Hasil pada 21 Oktober 2026 dengan Bun 1.4.3: **599 tes lulus, 6 gagal** dari 605 tes.
Pemeriksaan TypeScript backend, lint antarmuka, dan build produksi antarmuka lulus.
Kamus Indonesia mencakup seluruh key pada empat kamus sumber; placeholder juga diuji.

Enam kegagalan pengujian Windows juga direproduksi pada kode upstream sebelum
enrichment: pembuatan symlink, pemulihan checkpoint, dua asumsi permission POSIX,
pemisah path chunk audio, dan penghapusan folder backup yang masih terkunci.
Temuan tersebut perlu pekerjaan kompatibilitas Windows tersendiri.
