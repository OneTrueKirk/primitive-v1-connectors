const bre = require('hardhat')

const TRADER = {
  1: require('@primitivefi/contracts/deployments/live_1/Trader.json'),
  4: require('@primitivefi/contracts/deployments/rinkeby/Trader.json'),
}

const UNISWAPV2_ROUTER02 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAPV2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
const SUSHISWAP_ROUTER = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
const SUSHISWAP_FACTORY = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'

module.exports = async ({ getNamedAccounts, deployments }) => {
  const { log, deploy } = deployments
  const { deployer } = await getNamedAccounts()
  const chain = await bre.getChainId()

  const uniswapConnector = await deploy('UniswapConnector03', {
    from: deployer,
    contractName: 'UniswapConnector03',
    args: [SUSHISWAP_ROUTER, SUSHISWAP_FACTORY, TRADER[chain].address],
  })

  let deployed = [uniswapConnector]
  for (let i = 0; i < deployed.length; i++) {
    if (deployed[i].newlyDeployed)
      log(`Contract deployed at ${deployed[i].address} using ${deployed[i].receipt.gasUsed} gas on chain ${chain}`)
  }
}

module.exports.tags = ['Periphery']
