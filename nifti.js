"use strict"

var systemEndianness = (function() {
    var buf = new ArrayBuffer(4),
        intArr = new Uint32Array(buf),
        byteArr = new Uint8Array(buf)
    intArr[0] = 0x01020304
    if (byteArr[0]==1 && byteArr[1]==2 && byteArr[2]==3 && byteArr[3]==4) {
        return 'big'
    } else if (byteArr[0]==4 && byteArr[1]==3 && byteArr[2]==2 && byteArr[3]==1) {
        return 'little'
    }
    console.warn("Unrecognized system endianness!")
    return undefined
})()

// Parses a NIfTI header
module.exports.parseNIfTIHeader = parseNIfTIHeader
function parseNIfTIHeader(buffer_org) {
  var buf8 = new Uint8Array(buffer_org)
  var buffer = buf8.buffer // Make sure we have an ArrayBuffer
  var view = new DataView(buffer)
  if (buffer.byteLength<348) {
    throw new Error("The buffer is not even large enough to contain the minimal header I would expect from a NIfTI file!")
  }
  
  // First read dim[0], to determine byte order
  var littleEndian = true
  var dim = new Array(8)
  dim[0] = view.getInt16(40, littleEndian)
  if (1>dim[0] || dim[0]>7) {
    littleEndian = !littleEndian
    dim[0] = view.getInt16(40, littleEndian)
  }
  if (1>dim[0] || dim[0]>7) {
    // Even if there were other /byte/ orders, we wouldn't be able to detect them using a short (16 bits, so only two bytes).
    console.warn("dim[0] is out-of-range, we'll simply try continuing to read the file, but this will most likely fail horribly.")
  }
  
  // Now check header size and magic
  var sizeof_hdr = view.getInt32(0, littleEndian)
  if (sizeof_hdr !== 348 && (1>dim[0] || dim[0]>7)) {
    // Try to recover from weird dim info
    littleEndian = !littleEndian
    dim[0] = view.getInt16(40, littleEndian)
    sizeof_hdr = view.getInt32(0, littleEndian)
    if (sizeof_hdr !== 348) {
      throw new Error("I'm sorry, but I really cannot determine the byte order of the (NIfTI) file at all.")
    }
  } else if (sizeof_hdr < 348) {
    throw new Error("Header of file is smaller than expected, I cannot deal with this.")
  } else if (sizeof_hdr !== 348) {
    console.warn("Size of NIfTI header different from what I expect, but I'll try to do my best anyway (might cause trouble).")
  }
  var magic = String.fromCharCode.apply(null, buf8.subarray(344, 348))
  if (magic !== "ni1\0" && magic !== "n+1\0") {
    throw new Error("Sorry, but this does not appear to be a NIfTI-1 file. Maybe Analyze 7.5 format? or NIfTI-2?")
  }
  
  // Read some more structured header fields
  var dim_info = view.getInt8(39)
  dim.length = 1+Math.min(7, dim[0])
  for(var i=1; i<dim.length; i++) {
    dim[i] = view.getInt16(40+2*i, littleEndian)
    if (dim[i]<=0) {
      console.warn("dim[0] was probably wrong or corrupt")
      dim.length = i
    }
  }
  if (dim.length === 1) throw new Error("No valid dimensions!")
  
  var pixdim = new Array(dim.length)
  for(var i=0; i<pixdim.length; i++) {
    pixdim[i] = view.getFloat32(76+4*i, littleEndian)
  }
  
  var srow = new Float32Array(12)
  for(var i=0; i<12; i++) {
    srow[i] = view.getFloat32(280+4*i, littleEndian)
  }
  
  // Read simple header fields and build up object representing the header
  var header = {
    littleEndian: littleEndian,
    
    sizeof_hdr: sizeof_hdr,
    dim_info: dim_info,
    dim: dim,
    intent_p1: view.getFloat32(56, littleEndian),
    intent_p2: view.getFloat32(56, littleEndian),
    intent_p3: view.getFloat32(56, littleEndian),
    intent_code: view.getInt16(68, littleEndian),
  
    datatype: decodeNIfTIDataType(view.getInt16(70, littleEndian)),
    bitpix: view.getInt16(72, littleEndian),
    slice_start: view.getInt16(74, littleEndian),
    pixdim: pixdim,
    vox_offset: view.getFloat32(108, littleEndian),
    
    scl_slope: view.getFloat32(112, littleEndian),
    scl_inter: view.getFloat32(116, littleEndian),
    slice_end: view.getInt16(120, littleEndian),
    slice_code: view.getInt8(122),
    xyzt_units: decodeNIfTIUnits(view.getInt8(123)),
    cal_max: view.getFloat32(124, littleEndian),
    cal_min: view.getFloat32(128, littleEndian),
    slice_duration: view.getFloat32(132, littleEndian),
    toffset: view.getFloat32(136, littleEndian),
  
    descrip: String.fromCharCode.apply(null, buf8.subarray(148, 228)),
    aux_file: String.fromCharCode.apply(null, buf8.subarray(228, 252)),
  
    qform_code: view.getInt16(252, littleEndian),
    sform_code: view.getInt16(254, littleEndian),
  
    quatern_b: view.getFloat32(256, littleEndian),
    quatern_c: view.getFloat32(260, littleEndian),
    quatern_d: view.getFloat32(264, littleEndian),
    qoffset_x: view.getFloat32(268, littleEndian),
    qoffset_y: view.getFloat32(272, littleEndian),
    qoffset_z: view.getFloat32(276, littleEndian),
    
    srow: srow,
  
    intent_name: String.fromCharCode.apply(null, buf8.subarray(328, 344)),
    
    magic: magic,
  
    extension: buffer.byteLength < 348+4 ? [0,0,0,0] : [view.getInt8(348), view.getInt8(349), view.getInt8(350), view.getInt8(351)]
  }
  
  // Check bitpix
  
  // "Normalize" datatype (so that rgb/complex become several normal floats rather than compound types, possibly also do something about bits)
  // Note that there is actually both an rgb datatype and an rgb intent... (My guess is that the datatype corresponds to sizes = [3,dim[0],...], while the intent might correspond to sizes = [dim[0],...,dim[5]=3].)
  
  return header  
}

// Converts a NIfTI header to an NRRD-compatible structure
function NIfTIToNRRD(niftiHeader) {
  var ret = {}
  ret.dimension = niftiHeader.dim[0]
  ret.type = niftiHeader.datatype // TODO: Check that we do not feed anything incompatible?
  ret.encoding = 'raw'
  ret.endian = niftiHeader.littleEndian ? 'little' : 'big'
  ret.sizes = niftiHeader.dim.slice(1) // Note that both NRRD and NIfTI use the convention that the fastest axis comes first!
  ret.thicknesses=niftiHeader.pixdim.slice(1);

  if (niftiHeader.xyzt_units !== undefined) {
    ret.spaceUnits = niftiHeader.xyzt_units
    while(ret.spaceUnits.length < ret.dimension) { // Pad if necessary
      ret.spaceUnits.push("")
    }
    ret.spaceUnits.length = ret.dimension // Shrink if necessary
  }
  
  if (niftiHeader.qform_code === 0) { // "method 1"
    ret.spacings = niftiHeader.pixdim.slice(1)
    while(ret.spacings.length < ret.dimension) {
      ret.spacings.push(NaN)
    }
    ret.spaceDimension = Math.min(ret.dimension, 3) // There might be non-3D data sets? (Although the NIfTI format does seem /heavily/ reliant on assuming a 3D space.)
  } else if (niftiHeader.qform_code > 0) { // "method 2"
    // TODO: Figure out exactly what to do with the different qform codes.
    ret.space = "right-anterior-superior" // Any method for orientation (except for "method 1") uses this, apparently.
    var qfac = niftiHeader.pixdim[0] === 0.0 ? 1 : niftiHeader.pixdim[0]
    var a = Math.sqrt(Math.max(0.0,1.0-(niftiHeader.quatern_b*niftiHeader.quatern_b + niftiHeader.quatern_c*niftiHeader.quatern_c + niftiHeader.quatern_d*niftiHeader.quatern_d)))
    var b = niftiHeader.quatern_b
    var c = niftiHeader.quatern_c
    var d = niftiHeader.quatern_d
    ret.spaceDirections = [
      [niftiHeader.pixdim[1]*(a*a+b*b-c*c-d*d),niftiHeader.pixdim[1]*(2*b*c+2*a*d),niftiHeader.pixdim[1]*(2*b*d-2*a*c)],
      [niftiHeader.pixdim[2]*(2*b*c-2*a*d),niftiHeader.pixdim[2]*(a*a+c*c-b*b-d*d),niftiHeader.pixdim[2]*(2*c*d+2*a*b)],
      [qfac*niftiHeader.pixdim[3]*(2*b*d+2*a*c),qfac*niftiHeader.pixdim[3]*(2*c*d-2*a*b),qfac*niftiHeader.pixdim[3]*(a*a+d*d-c*c-b*b)]]
    ret.spaceOrigin = [niftiHeader.qoffset_x,niftiHeader.qoffset_y,niftiHeader.qoffset_z]
  } else {
    console.warn("Invalid qform_code: " + niftiHeader.qform_code + ", orientation is probably messed up.")
  }
  // TODO: Here we run into trouble, because in NRRD we cannot expose two DIFFERENT (not complementary, different!) transformations. Even more frustrating is that sform transformations are actually more compatible with NRRD than the qform methods.
  if (niftiHeader.sform_code > 0) {
    console.warn("sform transformation are currently ignored.")
  }
  /*if (niftiHeader.sform_code > 0) { // "method 3"
    ret.space = "right-anterior-superior" // Any method for orientation (except for "method 1") uses this, apparently.
    ret.spaceDirections = [
      [niftiHeader.srow[0*4 + 0],niftiHeader.srow[1*4 + 0],niftiHeader.srow[2*4 + 0]],
      [niftiHeader.srow[0*4 + 1],niftiHeader.srow[1*4 + 1],niftiHeader.srow[2*4 + 1]],
      [niftiHeader.srow[0*4 + 2],niftiHeader.srow[1*4 + 2],niftiHeader.srow[2*4 + 2]]]
    ret.spaceOrigin = [niftiHeader.srow[0*4 + 3],niftiHeader.srow[1*4 + 3],niftiHeader.srow[2*4 + 3]]
  }*/
  // TODO: Enforce that spaceDirections and so on have the correct size.
  
  // TODO: We're still missing an awful lot of info!
  
  return ret
}

// Just parses the header
// This expects an ArrayBuffer or (Node.js) Buffer
module.exports.parseHeader = function (buffer_org) {
  var niftiHeader = parseNIfTIHeader(buffer_org)
  var ret = NIfTIToNRRD(niftiHeader)
  return ret
}

// Parses both header and data
// This expects an ArrayBuffer or (Node.js) Buffer
module.exports.parse = function (buffer_org) {
  var niftiHeader = parseNIfTIHeader(buffer_org)
  var ret = NIfTIToNRRD(niftiHeader)

  if (niftiHeader.extension[0] !== 0) {
    console.warn("Looks like there are extensions in use in this NIfTI file, which will all be ignored!")
  }
  
  // Read data if it is here
  if (niftiHeader.magic === "n+1\0") {
    var buf8 = new Uint8Array(buffer_org)
    var buffer = buf8.buffer // Make sure we have an ArrayBuffer
    if (niftiHeader.vox_offset<352 || niftiHeader.vox_offset>buffer.byteLength) {
      throw new Error("Illegal vox_offset!")
    }
    ret.buffer = buffer.slice(Math.floor(niftiHeader.vox_offset))
    if (niftiHeader.datatype !== 0) {
      // TODO: It MIGHT make sense to equate DT_UNKNOWN (0) to 'block', with bitpix giving the block size in bits
      ret.data = parseNIfTIRawData(ret.buffer, niftiHeader.datatype, niftiHeader.dim, {endianFlag: niftiHeader.littleEndian})
    }
  }
  
  return ret
}

function parseNIfTIRawData(buffer, type, dim, options) {
  var i, arr, view, totalLen = 1, endianFlag = options.endianFlag, endianness = endianFlag ? 'little' : 'big'
  for(i=1; i<dim.length; i++) {
    totalLen *= dim[i]
  }
  if (type == 'block') {
    // Don't do anything special, just return the slice containing all blocks.
    return buffer.slice(0,totalLen*options.blockSize)
  } else if (type == 'int8' || type == 'uint8' || endianness == systemEndianness) {
    switch(type) {
    case "int8":
      checkSize(1)
      return new Int8Array(buffer.slice(0,totalLen))
    case "uint8":
      checkSize(1)
      return new Uint8Array(buffer.slice(0,totalLen))
    case "int16":
      checkSize(2)
      return new Int16Array(buffer.slice(0,totalLen*2))
    case "uint16":
      checkSize(2)
      return new Uint16Array(buffer.slice(0,totalLen*2))
    case "int32":
      checkSize(4)
      return new Int32Array(buffer.slice(0,totalLen*4))
    case "uint32":
      checkSize(4)
      return new Uint32Array(buffer.slice(0,totalLen*4))
    //case "int64":
    //  checkSize(8)
    //  return new Int64Array(buffer.slice(0,totalLen*8))
    //case "uint64":
    //  checkSize(8)
    //  return new Uint64Array(buffer.slice(0,totalLen*8))
    case "float":
      checkSize(4)
      return new Float32Array(buffer.slice(0,totalLen*4))
    case "double":
      checkSize(8)
      return new Float64Array(buffer.slice(0,totalLen*8))
    default:
      console.warn("Unsupported NIfTI type: " + type)
      return undefined
    }
  } else {
    view = new DataView(buffer)
    switch(type) {
    case "int8": // Note that here we do not need to check the size of the buffer, as the DataView.get methods should throw an exception if we read beyond the buffer.
      arr = new Int8Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getInt8(i)
      }
      return arr
    case "uint8":
      arr = new Uint8Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getUint8(i)
      }
      return arr
    case "int16":
      arr = new Int16Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getInt16(i*2)
      }
      return arr
    case "uint16":
      arr = new Uint16Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getUint16(i*2)
      }
      return arr
    case "int32":
      arr = new Int32Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getInt32(i*4)
      }
      return arr
    case "uint32":
      arr = new Uint32Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getUint32(i*4)
      }
      return arr
    //case "int64":
    //  arr = new Int64Array(totalLen)
    //  for(i=0; i<totalLen; i++) {
    //    arr[i] = view.getInt64(i*8)
    //  }
    // return arr
    //case "uint64":
    //  arr = new Uint64Array(totalLen)
    //  for(i=0; i<totalLen; i++) {
    //    arr[i] = view.getUint64(i*8)
    //  }
    //  return arr
    case "float":
      arr = new Float32Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getFloat32(i*4)
      }
      return arr
    case "double":
      arr = new Float64Array(totalLen)
      for(i=0; i<totalLen; i++) {
        arr[i] = view.getFloat64(i*8)
      }
      return arr
    default:
      console.warn("Unsupported NRRD type: " + type)
      return undefined
    }
  }
  function checkSize(sizeOfType) {
    if (buffer.byteLength<totalLen*sizeOfType) throw new Error("NIfTI file does not contain enough data!")
  }
}

function decodeNIfTIDataType(datatype) {
  switch(datatype) {
  case 1:
    return 'bit'
  case 2:
    return 'uint8'
  case 4:
    return 'int16'
  case 8:
    return 'int32'
  case 16:
    return 'float'
  case 32:
    return 'complex64'
  case 64:
    return 'double'
  case 128:
    return 'rgb24'
  case 256:
    return 'int8'
  case 512:
    return 'uint16'
  case 768:
    return 'uint32'
  case 1024:
    return 'int64'
  case 1280:
    return 'uint64'
  case 1536:
    return 'float128'
  case 1792:
    return 'complex128'
  case 2048:
    return 'complex256'
  case 2304:
    return 'rgba32'
  default:
    console.warn("Unrecognized NIfTI data type: " + datatype)
    return datatype
  }
}

function decodeNIfTIUnits(units) {
  var space, time
  switch(units & 7) {
  case 0:
    space = ""
    break
  case 1:
    space = "m"
    break
  case 2:
    space = "mm"
    break
  case 3:
    space = "um"
    break
  default:
    console.warn("Unrecognized NIfTI unit: " + (units&7))
    space = ""
  }
  switch(units & 56) {
  case 0:
    time = ""
    break
  case 8:
    time = "s"
    break
  case 16:
    time = "ms"
    break
  case 24:
    time = "us"
    break
  case 32:
    time = "Hz"
    break
  case 40:
    time = "ppm"
    break
  case 48:
    time = "rad/s"
    break
  default:
    console.warn("Unrecognized NIfTI unit: " + (units&56))
    time = ""
  }
  return (space === "" && time === "") ? undefined : [space, space, space, time]
}

