// Journal public transaction inputs before broadcast, so interruption never duplicates deployment.
import fs from 'node:fs';
export function extensionTransactions({pub, account, chainId, journal, save, viem}) {
  const {keccak256}=viem;
  const fields=t=>({...t,chainId,type:'eip1559',value:BigInt(t.value),gas:BigInt(t.gas),maxFeePerGas:BigInt(t.maxFeePerGas),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGas)});
  return async function send(label,tx) {
    if(await pub.getChainId()!==chainId)throw Error('Signing chain changed');
    let step=journal.steps[label];
    const intent=JSON.stringify({to:tx.to??null,data:tx.data,value:String(tx.value??0n)});
    if(step && step.intent!==intent)throw Error('Transaction intent changed: '+label);
    if(!step){
      const latest=await pub.getTransactionCount({address:account.address,blockTag:'latest'});
      const nonce=await pub.getTransactionCount({address:account.address,blockTag:'pending'});
      if(latest!==nonce)throw Error('Owner has a pending transaction; wait before resuming');
      const estimated=await pub.estimateGas({...tx,account:account.address});
      const fees=await pub.estimateFeesPerGas();
      const t={...tx,value:String(tx.value??0n),nonce,gas:String(estimated*135n/100n+50000n),maxFeePerGas:String(fees.maxFeePerGas),maxPriorityFeePerGas:String(fees.maxPriorityFeePerGas)};
      if(await pub.getBalance({address:account.address})<=BigInt(t.gas)*BigInt(t.maxFeePerGas)+BigInt(t.value))throw Error('Insufficient deployment ETH');
      const raw=await account.signTransaction(fields(t));
      step=journal.steps[label]={intent,tx:t,hash:keccak256(raw),status:'prepared'};save();
    }
    let receipt;
    try{receipt=await pub.getTransactionReceipt({hash:step.hash});}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
    if(!receipt){
      let known=false;
      try{await pub.getTransaction({hash:step.hash});known=true;}catch(e){if(e.name!=='TransactionNotFoundError')throw e;}
      if(!known){
        if(await pub.getTransactionCount({address:account.address,blockTag:'latest'})>step.tx.nonce)throw Error('Saved nonce was consumed; inspect '+step.hash);
        const raw=await account.signTransaction(fields(step.tx));
        if(keccak256(raw)!==step.hash)throw Error('Resigned transaction hash changed');
        console.log('Sending '+label+' '+step.hash);
        await pub.sendRawTransaction({serializedTransaction:raw});
      }
      receipt=await pub.waitForTransactionReceipt({hash:step.hash,timeout:120000});
    }
    if(receipt.status!=='success')throw Error(label+' reverted: '+step.hash);
    Object.assign(step,{status:'confirmed',blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),effectiveGasPrice:String(receipt.effectiveGasPrice),...(receipt.contractAddress?{contractAddress:receipt.contractAddress}:{})});save();
    console.log('Verified '+label);
    return receipt;
  };
}
