/** Public child diagnostics contain fixed enums and pinned /app source positions only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const CHILD_FRAME_BOUNDS_FILE=fileURLToPath(new URL('./presigned-deployment-child-frame-bounds.json',import.meta.url));
export const CHILD_FRAME_BOUNDS_SHA256='5052a02a3945a626abcb0d516a0b60014a458b14abaa3b0c527ac73562c32b22';
export const CHILD_CLASSES=Object.freeze(['Error','AssertionError','TypeError','RangeError','SyntaxError','ReferenceError','URIError','AbortError','AggregateError']);
export const CHILD_CODES=Object.freeze(['ERR_ASSERTION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE',
  'ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_URL',
  'ERR_UNHANDLED_ERROR','ERR_WORKER_OUT_OF_MEMORY','ABORT_ERR','ENOENT','EACCES','EPERM','EADDRINUSE','ECONNREFUSED','ETIMEDOUT','ENOBUFS','ENOMEM']);
const exact=(value,keys)=>{assert(value&&Object.getPrototypeOf(value)===Object.prototype);assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};
const data=(value,key)=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);assert(descriptor&&Object.hasOwn(descriptor,'value'));return descriptor.value;};
export function validateChildBoundsBytes(bytes){
  assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=256*1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),CHILD_FRAME_BOUNDS_SHA256);
  const bounds=JSON.parse(bytes);exact(bounds,['version','candidateCommit','sourceDigest','files']);
  assert(bounds.version===1&&bounds.candidateCommit==='94dc1046a29d2b027fc8186baa5932c1b1ab236a'&&
    bounds.sourceDigest==='83e9001523b7029a0da6e945be5e6258d5f50ed6f4f529cab9e70413cf7127bc');
  assert(bounds.files&&Object.getPrototypeOf(bounds.files)===Object.prototype&&Object.keys(bounds.files).length===26);
  for(const [file,caps]of Object.entries(bounds.files)){
    assert(/^(?:scripts|src|web)\/[A-Za-z0-9_./-]+\.(?:mjs|mts|ts)$/u.test(file)&&!file.split('/').some(part=>['','.','..'].includes(part)));
    assert(Array.isArray(caps)&&caps.length>0&&caps.length<=10000&&caps.every(cap=>Number.isSafeInteger(cap)&&cap>=1&&cap<=1024));
    Object.freeze(caps);
  }
  return Object.freeze(bounds.files);
}
export const CHILD_FRAME_BOUNDS=validateChildBoundsBytes(readFileSync(CHILD_FRAME_BOUNDS_FILE));
export function validateChildException(value){
  exact(value,['class','code','frames']);const kind=data(value,'class'),code=data(value,'code'),frames=data(value,'frames');
  assert(kind===null||CHILD_CLASSES.includes(kind));assert(code===null||CHILD_CODES.includes(code));
  assert(Array.isArray(frames)&&frames.length<=4&&Object.getPrototypeOf(frames)===Array.prototype);
  assert(kind!==null||(code===null&&frames.length===0));
  assert.deepEqual(Object.keys(frames),Array.from({length:frames.length},(_,index)=>String(index)));
  const seen=new Set(),checked=[];
  for(let index=0;index<frames.length;index++){
    const frame=data(frames,String(index));
    exact(frame,['file','line']);const file=data(frame,'file'),line=data(frame,'line');
    assert(typeof file==='string'&&Object.hasOwn(CHILD_FRAME_BOUNDS,file)&&Number.isSafeInteger(line)&&line>=1&&line<=CHILD_FRAME_BOUNDS[file].length);
    const identity=file+':'+line;assert(!seen.has(identity));seen.add(identity);checked.push(Object.freeze({file,line}));
  }
  return Object.freeze({class:kind,code,frames:Object.freeze(checked)});
}
