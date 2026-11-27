require('dotenv').config();
const path = require('path');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new MongoClient(process.env.MONGODB_URI);
let db;

// Captura errores de las rutas async
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));

// Solo el administrador (con la clave del .env) puede crear, editar o eliminar
const soloAdmin = (req, res, next) =>
  process.env.ADMIN_PASSWORD && req.get('x-clave') === process.env.ADMIN_PASSWORD
    ? next() : res.status(401).json({ error: 'No autorizado' });

// Convierte lo que llega del formulario en un documento de MongoDB
const armar = b => ({
  nombre: String(b.nombre).trim(),
  descripcion: String(b.descripcion || '').trim(),
  precio: Number(b.precio),
  categoriaId: new ObjectId(b.categoriaId),   // referencia a categorias._id
  imagen: String(b.imagen || '').trim(),      // URL de la foto
  disponible: b.disponible !== false,
  destacado: b.destacado === true            // banner de "plato destacado" (máximo 3)
});

// Regla de negocio: como máximo 3 platos activos pueden ser destacados
async function validarDestacados(destacado, idActual) {
  if (!destacado) return;
  const filtro = { activo: true, destacado: true };
  if (idActual) filtro._id = { $ne: new ObjectId(idActual) };
  if ((await db.collection('platos').countDocuments(filtro)) >= 3)
    throw new Error('Solo puede haber 3 platos destacados como máximo');
}

// Panel del administrador (página aparte, sin enlaces desde el menú)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/login', soloAdmin, (req, res) => res.json({ ok: true }));

// LEER (solo registros activos)
app.get('/api/categorias', wrap(async (req, res) =>
  res.json(await db.collection('categorias').find({ activo: true }).sort({ orden: 1 }).toArray())));
app.get('/api/platos', wrap(async (req, res) =>
  res.json(await db.collection('platos').find({ activo: true }).sort({ nombre: 1 }).toArray())));

// CREAR
app.post('/api/platos', soloAdmin, wrap(async (req, res) => {
  await validarDestacados(req.body.destacado === true);
  const doc = { ...armar(req.body), activo: true, fechaCreacion: new Date() };
  const r = await db.collection('platos').insertOne(doc);
  res.status(201).json({ ...doc, _id: r.insertedId });
}));

// ACTUALIZAR
app.put('/api/platos/:id', soloAdmin, wrap(async (req, res) => {
  await validarDestacados(req.body.destacado === true, req.params.id);
  await db.collection('platos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { ...armar(req.body), fechaActualizacion: new Date() } });
  res.json({ ok: true });
}));

// ELIMINAR (borrado lógico: activo = false)
app.patch('/api/platos/:id/eliminar', soloAdmin, wrap(async (req, res) => {
  await db.collection('platos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { activo: false, fechaActualizacion: new Date() } });
  res.json({ ok: true });
}));

// CONSULTA AVANZADA: agregación con $match, $group y $lookup (une platos con categorias)
app.get('/api/estadisticas', soloAdmin, wrap(async (req, res) =>
  res.json(await db.collection('platos').aggregate([
    { $match: { activo: true } },
    { $group: { _id: '$categoriaId', total: { $sum: 1 }, precioPromedio: { $avg: '$precio' }, precioMax: { $max: '$precio' } } },
    { $lookup: { from: 'categorias', localField: '_id', foreignField: '_id', as: 'cat' } },
    { $project: { _id: 0, categoria: { $arrayElemAt: ['$cat.nombre', 0] }, total: 1,
                  precioPromedio: { $round: ['$precioPromedio', 2] }, precioMax: 1 } },
    { $sort: { categoria: 1 } }
  ]).toArray())));

async function iniciar() {
  await client.connect();
  console.log('Conectado a MongoDB Atlas');
  db = client.db('chef_ejecutivo');

  // Diseño de la base de datos: colecciones, validación e índices
  const existentes = (await db.listCollections().toArray()).map(c => c.name);
  if (!existentes.includes('categorias')) await db.createCollection('categorias');
  if (!existentes.includes('platos')) {
    await db.createCollection('platos', { validator: { $jsonSchema: {
      bsonType: 'object',
      required: ['nombre', 'precio', 'categoriaId', 'disponible', 'activo'],
      properties: {
        nombre: { bsonType: 'string', minLength: 2 },
        descripcion: { bsonType: 'string' },
        precio: { bsonType: ['int', 'double'], minimum: 0 },
        categoriaId: { bsonType: 'objectId' },
        imagen: { bsonType: 'string' },
        disponible: { bsonType: 'bool' },
        activo: { bsonType: 'bool' },
        destacado: { bsonType: 'bool' }
      } } } });
  }
  await db.collection('categorias').createIndex({ nombre: 1 }, { unique: true });
  await db.collection('platos').createIndex({ categoriaId: 1, activo: 1 });

  // Datos iniciales (solo si las colecciones están vacías)
  if ((await db.collection('categorias').countDocuments()) === 0) {
    await db.collection('categorias').insertMany(['Entrantes', 'Platos Fuertes', 'Postres', 'Bebidas']
      .map((nombre, i) => ({ nombre, orden: i + 1, activo: true })));
  }
  if ((await db.collection('platos').countDocuments()) === 0) {
    const id = {};
    for (const c of await db.collection('categorias').find().toArray()) id[c.nombre] = c._id;
    const d = (nombre, descripcion, precio, cat) => ({ nombre, descripcion, precio, categoriaId: id[cat],
      imagen: '', disponible: true, activo: true, fechaCreacion: new Date() });
    await db.collection('platos').insertMany([
      d('Ensalada de Trufa', 'Mezclum con trufa de hongos, crema de ajo.', 35, 'Entrantes'),
      d('Salmón Ventricina', 'Salmón con verduras asadas, picante.', 42, 'Entrantes'),
      d('Ñoñitos', 'Pasta con salsa de tomate, albahaca.', 38, 'Platos Fuertes'),
      d('Pasta Camarones', 'Pasta cremosa con camarones y hierbas.', 55, 'Platos Fuertes'),
      d('Tabla Individual', 'Parrillada con papas y ensalada.', 60, 'Platos Fuertes'),
      d('Postre de Chocolate', 'Delicioso pastel de chocolate.', 25, 'Postres'),
      d('Jugo Natural', 'Jugo de naranja natural.', 12, 'Bebidas')]);
  }
  const PUERTO = process.env.PORT || 3000;
  app.listen(PUERTO, () => console.log('Servidor listo en el puerto ' + PUERTO + ' -> http://localhost:' + PUERTO));
}
iniciar().catch(e => console.error('Error de conexión:', e.message));
